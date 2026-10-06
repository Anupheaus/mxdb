import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2E_MONGO_DB_NAME, setupE2E, teardownE2E, useClient, useServer, waitUntilAsync } from '../setup';
import { ACCESS_LIST_RECORD_ID, AUTH_COLLECTION_NAME, TENANT_DB_NAME } from './readGateContext.constants';
import { newRecordId } from './utils';

/**
 * The read gate on the change-stream path (sc-999). A change reaches each connection from the tenant database's
 * change stream, outside any request; the gate is run for it through the `AsyncResource.bind` in
 * `startAuthenticatedServer.ts`, so it must see THAT connection's tenant database and its signed-in user — not the
 * default database, and not whoever's connection the change stream happened to start in. (`ServerDb.onChange` also
 * runs each connection's listener in the context it was registered in; the test holds whichever layer does the work:
 * with neither, the edit after Bob loses access is judged as someone else and his copy is never evicted.)
 *
 * The server (`readGateContext.serverExtensions.ts`) routes every connection to a tenant database, and its gate
 * reads an access list there each time it runs. Bob holds no query subscription that could deliver the record (his
 * subscription was gated when no list existed), so after his one `get` only the change stream can reach him.
 */
describe('e2e read gate from a change-stream callback', () => {
  let mongo: MongoClient;

  async function dropTenantDb(): Promise<void> {
    await mongo.db(TENANT_DB_NAME).dropDatabase();
  }

  beforeAll(async () => {
    await setupE2E({ serverExtensionsModule: fileURLToPath(new URL('./readGateContext.serverExtensions.ts', import.meta.url)) });
    mongo = new MongoClient(useServer().mongoUri);
    await mongo.connect();
    await dropTenantDb();
  }, 90_000);

  afterAll(async () => {
    await dropTenantDb();
    await mongo.close();
    await teardownE2E();
  }, 30_000);

  /**
   * The dev sign-in route is a plain route, outside the connection routing, so it stores the session in the default
   * database. Copy it into the tenant database, where the routed socket looks it up.
   */
  async function copySessionToTenant(userId: string): Promise<void> {
    const sessions = await mongo.db(E2E_MONGO_DB_NAME).collection(AUTH_COLLECTION_NAME).find({ userId }).toArray();
    const tenantSessions = mongo.db(TENANT_DB_NAME).collection(AUTH_COLLECTION_NAME);
    for (const session of sessions) await tenantSessions.replaceOne({ _id: session._id }, session, { upsert: true });
  }

  function tenantClient(label: string): ReturnType<typeof useClient> {
    return useClient(label, { afterDevSignIn: copySessionToTenant });
  }

  async function waitForTenantRecord(id: string, isStored: (record: { tags?: string[]; value?: string } | null) => boolean): Promise<void> {
    await waitUntilAsync(async () => isStored(await mongo.db(TENANT_DB_NAME).collection<{ _id: string; tags?: string[]; value?: string }>('e2eTest').findOne({ _id: id })), `tenant record "${id}"`, 30_000);
  }

  it('judges a change for each connection as its own user, against its own tenant database', async () => {
    // Alice connects first, so the tenant change stream starts in her connection's context, not Bob's.
    const alice = tenantClient('alice');
    await alice.connect();
    const bob = tenantClient('bob');
    await bob.connect();
    const noteId = newRecordId('e2e-gated-note');

    await alice.upsert({ id: ACCESS_LIST_RECORD_ID, clientId: 'alice', tags: ['e2e-alice', 'e2e-bob'] });
    await alice.upsert({ id: noteId, clientId: 'alice', value: 'first' });
    await waitForTenantRecord(noteId, record => record?.value === 'first');
    // Nothing was written to the default database: the connections really work in the tenant one.
    expect(await useServer().readLiveRecords()).toEqual([]);

    // Bob may read the note (he is on the list): he fetches it once, so he now holds it.
    expect((await bob.get(noteId))?.value).toBe('first');

    // Alice edits it. Bob's gate, run from the change stream, finds the list in the tenant database: he gets the edit.
    await alice.upsert({ id: noteId, clientId: 'alice', value: 'second' });
    await waitUntilAsync(async () => (await bob.getLocalRecord(noteId))?.value === 'second', 'Bob receives the edit through the change stream', 30_000);

    // Alice takes Bob off the list, then edits the note again. Judged as Bob (not as Alice, who may still read it),
    // the note has left his gate: it is evicted from his device, and the new content never reaches him.
    await alice.upsert({ id: ACCESS_LIST_RECORD_ID, clientId: 'alice', tags: ['e2e-alice'] });
    await waitForTenantRecord(ACCESS_LIST_RECORD_ID, record => record?.tags?.includes('e2e-bob') === false);
    await alice.upsert({ id: noteId, clientId: 'alice', value: 'third' });
    await waitForTenantRecord(noteId, record => record?.value === 'third');
    await waitUntilAsync(async () => (await bob.getLocalRecord(noteId)) == null, 'the note is evicted from Bob\'s device', 30_000);
    expect((await alice.getLocalRecord(noteId))?.value).toBe('third');
  }, 120_000);
});
