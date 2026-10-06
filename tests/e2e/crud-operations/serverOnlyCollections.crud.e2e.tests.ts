import { fileURLToPath } from 'url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditor, AuditEntryType, type AuditEntry } from '../../../src/common';
import { setupE2E, teardownE2E, useClient, useServer, type E2EClientHandle } from '../setup';
import { GATED_VALUE, serverOnlyProbeAction, serverOnlySecretsCollection, type ServerOnlySecret } from './serverOnlyCollections.fixture';
import { newRecordId } from './utils';

/**
 * A hostile client and a server-only collection (sc-1401). The client app's own hook refuses to open a server-only
 * collection, but a signed-in client can send the raw socket requests itself. Each test here does exactly that, naming
 * the server-only collection in every request a client can make — sync (retrieve, update, delete, create), get,
 * getAll, query, distinct, reconcile and the three subscriptions — and asserts the server refused it: an error came
 * back, nothing about the records was sent to the socket, and what is stored is unchanged. The same requests against
 * the synchronised collection still work, its read gate included, and the server itself still reads and writes the
 * server-only collection (`serverOnlyCollections.serverExtensions.ts`).
 */

const ACTION_EVENT = 'nexus.actions';
const SUBSCRIPTION_EVENT = 'nexus.subscriptions';
const SECRET_TOKEN = 'ya29.stored-oauth-token';
const COLLECTION_NAME = serverOnlySecretsCollection.name;
/** How long a push the server sent after answering a request may take to arrive (an unrefused get's push takes a few ms). */
const PUSH_SETTLE_MS = 1_000;
/** A record hash no stored version has. */
const STALE_HASH = 'stale-hash';

interface RefusalAck {
  error?: { message?: string };
}

describe('e2e a hostile client naming a server-only collection', () => {
  let hostile: E2EClientHandle;
  let secret: ServerOnlySecret;

  /** The server's own write and read of the server-only collection (its probe action), as a job or webhook would. */
  async function serverProbe(upsert?: ServerOnlySecret[]): Promise<ServerOnlySecret[]> {
    const answer = await hostile.sendRawRequest(`${ACTION_EVENT}.${serverOnlyProbeAction.name}`, { upsert }) as ServerOnlySecret[] | RefusalAck;
    if (!Array.isArray(answer)) throw new Error(`The server probe failed: ${JSON.stringify(answer)}`);
    return answer;
  }

  function sendAction(actionName: string, payload: unknown): Promise<unknown> {
    return hostile.sendRawRequest(`${ACTION_EVENT}.${actionName}`, payload);
  }

  function subscribe(subscriptionName: string, request: unknown): Promise<unknown> {
    return hostile.sendRawRequest(`${SUBSCRIPTION_EVENT}.${subscriptionName}`, { action: 'subscribe', request, subscriptionId: newRecordId('hostile-sub') });
  }

  /** The request was refused with the one answer every such request gets. */
  function expectRefused(answer: unknown): void {
    expect((answer as RefusalAck)?.error?.message).toBe('This request could not be accepted.');
  }

  /**
   * Nothing the server sent the socket mentions the collection or what it holds. A read reaches the client as a push
   * after the request is answered, so this waits for any push to arrive first.
   */
  async function expectNothingSent(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, PUSH_SETTLE_MS));
    const sent = JSON.stringify(hostile.getReceivedEvents());
    expect(sent).not.toContain(COLLECTION_NAME);
    expect(sent).not.toContain(SECRET_TOKEN);
  }

  /** A sync request carrying `entries` for record `id` in the server-only collection, claiming to hold version `hash`. */
  function syncRequest(id: string, entries: AuditEntry[], hash?: string): unknown {
    return [{ collectionName: COLLECTION_NAME, records: [{ id, hash, entries }] }];
  }

  beforeAll(async () => {
    await setupE2E({ serverExtensionsModule: fileURLToPath(new URL('./serverOnlyCollections.serverExtensions.ts', import.meta.url)) });
    hostile = useClient('hostile');
    await hostile.connect();
  }, 90_000);

  afterAll(async () => {
    await teardownE2E();
  }, 30_000);

  beforeEach(async () => {
    secret = { id: newRecordId('secret'), token: SECRET_TOKEN };
    await serverProbe([secret]);
  });

  it('lets the server itself write and read the server-only collection', async () => {
    const another = { id: newRecordId('secret'), token: 'another-token' };
    const stored = await serverProbe([another]);
    expect(stored).toEqual(expect.arrayContaining([secret, another]));
  });

  it('answers a sync request asking for a server-only record with nothing about it', async () => {
    // Claiming a stale version of the record: unrefused, the server would answer with its stored copy.
    const probe = syncRequest(secret.id, [{ type: AuditEntryType.Branched, id: auditor.generateUlid() }], STALE_HASH);
    expectRefused(await sendAction('mxdbClientToServerSyncAction', probe));
    await expectNothingSent();
  });

  it('refuses a synced update to a server-only record, leaving it unchanged', async () => {
    const forged = { ...secret, token: 'forged-token' };
    const { entries } = auditor.updateAuditWith(forged, auditor.createAuditFrom(secret), secret);
    expectRefused(await sendAction('mxdbClientToServerSyncAction', syncRequest(secret.id, entries)));
    expect(await serverProbe()).toContainEqual(secret);
    await expectNothingSent();
  });

  it('refuses a synced delete of a server-only record, which still exists', async () => {
    const { entries } = auditor.delete(auditor.createAuditFrom(secret));
    expectRefused(await sendAction('mxdbClientToServerSyncAction', syncRequest(secret.id, entries)));
    expect(await serverProbe()).toContainEqual(secret);
    await expectNothingSent();
  });

  it('refuses a synced create in a server-only collection, storing nothing', async () => {
    const planted = { id: newRecordId('planted'), token: 'planted-token' };
    const { entries } = auditor.createAuditFrom(planted);
    expectRefused(await sendAction('mxdbClientToServerSyncAction', syncRequest(planted.id, entries)));
    expect((await serverProbe()).ids()).not.toContain(planted.id);
  });

  it('refuses the whole of a sync request that also names a synchronised collection', async () => {
    const synced = { id: newRecordId('synced'), clientId: 'hostile', value: 'alongside' };
    const request = [
      { collectionName: 'e2eTest', records: [{ id: synced.id, entries: auditor.createAuditFrom(synced).entries }] },
      { collectionName: COLLECTION_NAME, records: [{ id: secret.id, entries: auditor.delete(auditor.createAuditFrom(secret)).entries }] },
    ];
    expectRefused(await sendAction('mxdbClientToServerSyncAction', request));
    expect((await useServer().readLiveRecords()).ids()).not.toContain(synced.id);
    expect(await serverProbe()).toContainEqual(secret);
  });

  it('refuses get, getAll, query, distinct and reconcile requests, returning no data', async () => {
    expectRefused(await sendAction('mxdbGetAction', { collectionName: COLLECTION_NAME, ids: [secret.id] }));
    expectRefused(await sendAction('mxdbGetAllAction', { collectionName: COLLECTION_NAME }));
    expectRefused(await sendAction('mxdbQueryAction', { collectionName: COLLECTION_NAME, filters: { token: SECRET_TOKEN } }));
    expectRefused(await sendAction('mxdbDistinctAction', { collectionName: COLLECTION_NAME, field: 'token' }));
    expectRefused(await sendAction('mxdbReconcileAction', [{ collectionName: COLLECTION_NAME, localIds: [secret.id, 'never-stored'] }]));
    await expectNothingSent();
  });

  it('refuses query, distinct and getAll subscriptions', async () => {
    expectRefused(await subscribe('mxdbQuerySubscription', { collectionName: COLLECTION_NAME }));
    expectRefused(await subscribe('mxdbDistinctSubscription', { collectionName: COLLECTION_NAME, field: 'token' }));
    expectRefused(await subscribe('mxdbGetAllSubscription', { collectionName: COLLECTION_NAME }));
    // A change after the attempt is not pushed either: no subscription was set up.
    await serverProbe([{ ...secret, token: `${SECRET_TOKEN}-rotated` }]);
    await expectNothingSent();
  });

  it('still answers the same requests for a synchronised collection, through its read gate', async () => {
    const visible = { id: newRecordId('visible'), clientId: 'hostile', value: 'visible' };
    const gated = { id: newRecordId('gated'), clientId: 'hostile', value: GATED_VALUE };
    const synced = await sendAction('mxdbClientToServerSyncAction', [{
      collectionName: 'e2eTest',
      records: [visible, gated].map(record => ({ id: record.id, entries: auditor.createAuditFrom(record).entries })),
    }]);
    expect(synced).toEqual([expect.objectContaining({ collectionName: 'e2eTest', successfulRecordIds: expect.arrayContaining([visible.id, gated.id]) })]);
    expect(await sendAction('mxdbGetAction', { collectionName: 'e2eTest', ids: [visible.id, gated.id] })).toEqual([visible.id]);
    expect(await sendAction('mxdbReconcileAction', [{ collectionName: 'e2eTest', localIds: [visible.id] }])).toEqual([{ collectionName: 'e2eTest', deletedIds: [] }]);
    const subscribed = await subscribe('mxdbGetAllSubscription', { collectionName: 'e2eTest' }) as { response?: string[] };
    expect(subscribed.response).toContain(visible.id);
    expect(subscribed.response).not.toContain(gated.id);
  });
});
