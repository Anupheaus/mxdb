import { MongoClient, type Collection, type Document } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { e2eTestCollection } from '../setup/types';
import {
  E2E_MONGO_DB_NAME,
  resetE2E,
  setupE2E,
  teardownE2E,
  useClient,
  useServer,
  waitForAllClientsIdle,
  waitUntilAsync,
} from '../setup';
import { newRecordId, seedRowWithBOnGetAll } from './utils';

/**
 * sc-3577 — a record written straight to the database (a support fix by hand, a migration), not through mxdb, reaches
 * a client that holds it: while it is connected, and when it reconnects after being offline. Such a write leaves the
 * stored `_meta.hash` describing the old content; the C2S meta fast-path used to read it as "the client is up to date",
 * and an `update` (a `$set`) carried no document on the change stream, so it was dropped.
 */

type StoredDocument = Document & { _id: string; value?: string; _meta?: { hash?: string } };

/** Runs `delegate` against the live e2e collection, as a script or a person at the database would. */
async function withLiveCollection<T>(delegate: (documents: Collection<StoredDocument>) => Promise<T>): Promise<T> {
  const client = new MongoClient(useServer().mongoUri);
  try {
    await client.connect();
    return await delegate(client.db(E2E_MONGO_DB_NAME).collection<StoredDocument>(e2eTestCollection.name));
  } finally {
    await client.close();
  }
}

/** Long enough for the server's change stream to have seen a write (it batches for a few milliseconds). */
const SERVER_SEES_WRITE_MS = 2_000;
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const readStored =(id: string): Promise<StoredDocument | null> => withLiveCollection(documents => documents.findOne({ _id: id }));

async function waitForLocalValue(client: ReturnType<typeof useClient>, id: string, value: string): Promise<void> {
  await waitUntilAsync(async () => (await client.getLocalRecord(id))?.value === value, `the client holds value "${value}" for "${id}"`, 30_000);
}

describe('e2e records written without mxdb', () => {
  beforeAll(async () => {
    await setupE2E();
  }, 90_000);

  beforeEach(async () => {
    await resetE2E();
  });

  afterAll(async () => {
    await teardownE2E();
  }, 30_000);

  it('a $set made while B is offline reaches B when it reconnects', async () => {
    const a = useClient('a');
    const b = useClient('b');
    const id = newRecordId('e2e-direct-set-offline');
    await seedRowWithBOnGetAll(a, b, id);
    await waitForAllClientsIdle([a, b]);

    await b.disconnect();
    await withLiveCollection(documents => documents.updateOne({ _id: id }, { $set: { value: 'cancelled-by-hand' } }));
    await pause(SERVER_SEES_WRITE_MS);
    await b.reconnect();

    await waitForLocalValue(b, id, 'cancelled-by-hand');
    await waitForLocalValue(a, id, 'cancelled-by-hand');
  }, 120_000);

  it('a $set made while B is online reaches B', async () => {
    const a = useClient('a');
    const b = useClient('b');
    const id = newRecordId('e2e-direct-set-online');
    await seedRowWithBOnGetAll(a, b, id);
    await waitForAllClientsIdle([a, b]);

    await withLiveCollection(documents => documents.updateOne({ _id: id }, { $set: { value: 'moved-by-hand' } }));

    await waitForLocalValue(b, id, 'moved-by-hand');
    await waitForLocalValue(a, id, 'moved-by-hand');
  }, 120_000);

  it('a replacement that copies the old stored hash, made while B is offline, reaches B when it reconnects', async () => {
    const a = useClient('a');
    const b = useClient('b');
    const id = newRecordId('e2e-direct-replace-offline');
    await seedRowWithBOnGetAll(a, b, id);
    await waitForAllClientsIdle([a, b]);
    const stored = (await readStored(id))!;
    expect(stored._meta?.hash, 'mxdb stored a content hash').toEqual(expect.any(String));

    await b.disconnect();
    await withLiveCollection(documents => documents.replaceOne({ _id: id }, { ...stored, value: 'migrated' }));
    await pause(SERVER_SEES_WRITE_MS);
    await b.reconnect();

    await waitForLocalValue(b, id, 'migrated');
  }, 120_000);

  it('a record inserted without mxdb (so with no audit), changed while B is offline, reaches B when it reconnects', async () => {
    const b = useClient('b');
    const id = newRecordId('e2e-direct-unaudited');
    await withLiveCollection(documents => documents.insertOne({ _id: id, clientId: 'script', testDate: Date.now(), value: 'booked' }));
    await b.connect();
    await b.subscribeGetAll();
    await waitForLocalValue(b, id, 'booked');
    await waitForAllClientsIdle([b]);

    await b.disconnect();
    await withLiveCollection(documents => documents.updateOne({ _id: id }, { $set: { value: 'cancelled-by-hand' } }));
    await pause(SERVER_SEES_WRITE_MS);
    await b.reconnect();

    await waitForLocalValue(b, id, 'cancelled-by-hand');
  }, 120_000);

  it('the server clears the stored hash such a write leaves behind, so a reconnecting client is compared in full', async () => {
    const a = useClient('a');
    const id = newRecordId('e2e-direct-stale-hash');
    await a.connect();
    await a.upsert({ id, clientId: 'a', value: 'booked' });
    await useServer().waitForLiveRecord(id);
    await waitForAllClientsIdle([a]);
    expect((await readStored(id))?._meta?.hash).toEqual(expect.any(String));

    await withLiveCollection(documents => documents.updateOne({ _id: id }, { $set: { value: 'cancelled-by-hand' } }));

    await waitUntilAsync(async () => (await readStored(id))?._meta?.hash == null, 'the stale stored hash is cleared', 30_000);
    expect((await readStored(id))?.value, 'the write itself is kept').toBe('cancelled-by-hand');
  }, 120_000);

  it('an edit made through mxdb keeps its stored hash (it is never taken for a stale one)', async () => {
    const a = useClient('a');
    const b = useClient('b');
    const id = newRecordId('e2e-direct-control');
    const created = await seedRowWithBOnGetAll(a, b, id);

    await a.upsert({ ...created, value: 'edited-in-the-app', tags: ['one', 'two'], metadata: { count: 2, tag: 'x' } });
    await waitForAllClientsIdle([a, b]);
    await waitForLocalValue(b, id, 'edited-in-the-app');
    await pause(SERVER_SEES_WRITE_MS);

    expect((await readStored(id))?._meta?.hash).toEqual(expect.any(String));
  }, 120_000);
});
