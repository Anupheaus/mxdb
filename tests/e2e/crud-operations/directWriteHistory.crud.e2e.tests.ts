import { MongoClient, type Collection, type Document } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { e2eTestCollection, type E2eTestRecord } from '../setup/types';
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
import { AuditEntryType, entriesOf, OperationType, type ServerAuditEntry } from '../../../src/common';
import { getServerAudit, newRecordId, seedRowWithBOnGetAll } from './utils';

/**
 * sc-5449 — a change written straight to the database (a support fix by hand, a migration) on a record that already has a
 * history is kept by the next edit made in the app or on a device. The server rebuilds the record a later edit is laid over
 * from its history, which never saw the direct change, so the edit used to put the old value back without a word.
 *
 * Each test edits the record through mxdb first, so it has a history beyond its create, then changes `value` directly,
 * then edits a DIFFERENT field through mxdb. The direct value must survive, the edit must be applied, and the history must
 * show the direct change as its own entry, attributed to a change made outside the app.
 */

type StoredDocument = Document & { _id: string; value?: string; name?: string | null; _meta?: { hash?: string } };

const DIRECT_WRITE_USER_ID = '__mxdb_direct_write__';

/** Long enough for the server's change stream to have seen a write (it batches for a few milliseconds). */
const SERVER_SEES_WRITE_MS = 2_000;
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function withLiveCollection<T>(delegate: (documents: Collection<StoredDocument>) => Promise<T>): Promise<T> {
  const client = new MongoClient(useServer().mongoUri);
  try {
    await client.connect();
    return await delegate(client.db(E2E_MONGO_DB_NAME).collection<StoredDocument>(e2eTestCollection.name));
  } finally {
    await client.close();
  }
}

const readStored = (id: string): Promise<StoredDocument | null> => withLiveCollection(documents => documents.findOne({ _id: id }));

async function waitForLocal(client: ReturnType<typeof useClient>, id: string, isWanted: (record: E2eTestRecord | undefined) => boolean, what: string): Promise<void> {
  await waitUntilAsync(async () => isWanted(await client.getLocalRecord(id)), what, 30_000);
}

async function waitForStored(id: string, isWanted: (stored: StoredDocument | null) => boolean, what: string): Promise<void> {
  await waitUntilAsync(async () => isWanted(await readStored(id)), what, 30_000);
}

function directWriteEntriesOf(entries: ServerAuditEntry<E2eTestRecord>[]): ServerAuditEntry<E2eTestRecord>[] {
  return entries.filter(({ userId }) => userId === DIRECT_WRITE_USER_ID);
}

/** The history holds exactly one entry for the direct change: an update of `value` to `directValue`, made outside the app. */
async function expectDirectChangeInHistory(id: string, directValue: string): Promise<void> {
  const entries = entriesOf(await getServerAudit(id)) as ServerAuditEntry<E2eTestRecord>[];
  const directEntries = directWriteEntriesOf(entries);
  expect(directEntries, 'one entry records the direct change').toHaveLength(1);
  expect(directEntries[0]).toMatchObject({
    type: AuditEntryType.Updated,
    ops: [{ type: OperationType.Replace, path: 'value', value: directValue }],
  });
  const people = entries.filter(({ userId }) => userId !== DIRECT_WRITE_USER_ID);
  expect(people.length, 'the app\'s own entries are still there').toBeGreaterThan(1);
}

/** A creates the record and edits it once, so it has a history beyond its create; B holds it. */
async function seedWithHistory(id: string): Promise<E2eTestRecord> {
  const a = useClient('a');
  const b = useClient('b');
  const created = await seedRowWithBOnGetAll(a, b, id);
  const edited: E2eTestRecord = { ...created, name: 'first edit', testDate: 1 };
  await a.upsert(edited);
  await waitForStored(id, stored => stored?.name === 'first edit', 'the first edit is stored');
  await waitForLocal(b, id, record => record?.name === 'first edit', 'B holds the first edit');
  await waitForAllClientsIdle([a, b]);
  return edited;
}

describe('e2e a change written without mxdb survives later edits (sc-5449)', () => {
  beforeAll(async () => {
    await setupE2E();
  }, 90_000);

  beforeEach(async () => {
    await resetE2E();
  });

  afterAll(async () => {
    await teardownE2E();
  }, 30_000);

  it('an edit made in the app after a direct $set keeps the direct change', async () => {
    const a = useClient('a');
    const id = newRecordId('e2e-direct-kept-app');
    const edited = await seedWithHistory(id);

    await withLiveCollection(documents => documents.updateOne({ _id: id }, { $set: { value: 'cancelled-by-hand' } }));
    await waitForLocal(a, id, record => record?.value === 'cancelled-by-hand', 'A holds the direct change');
    await pause(SERVER_SEES_WRITE_MS);

    await a.upsert({ ...edited, value: 'cancelled-by-hand', name: 'second edit' });
    await waitForStored(id, stored => stored?.name === 'second edit', 'the second edit is stored');
    await waitForAllClientsIdle([a]);

    expect((await readStored(id))?.value, 'the direct change is kept').toBe('cancelled-by-hand');
    await expectDirectChangeInHistory(id, 'cancelled-by-hand');
  }, 120_000);

  it('an edit from a client that never received the direct change (an old copy) keeps it, changing only its own field', async () => {
    const a = useClient('a');
    const b = useClient('b');
    const id = newRecordId('e2e-direct-kept-old-copy');
    const edited = await seedWithHistory(id);

    await b.disconnect();
    await withLiveCollection(documents => documents.updateOne({ _id: id }, { $set: { value: 'cancelled-by-hand' } }));
    await pause(SERVER_SEES_WRITE_MS);
    // B edits another field on the copy it held before the direct change, then comes back.
    await b.upsert({ ...edited, name: 'edited offline' });
    await b.reconnect();

    await waitForStored(id, stored => stored?.name === 'edited offline', 'B\'s offline edit is stored');
    await waitForLocal(b, id, record => record?.value === 'cancelled-by-hand' && record.name === 'edited offline', 'B holds both changes');
    await waitForLocal(a, id, record => record?.value === 'cancelled-by-hand' && record.name === 'edited offline', 'A holds both changes');
    await waitForAllClientsIdle([a, b]);

    expect((await readStored(id))?.value, 'the direct change is kept').toBe('cancelled-by-hand');
    await expectDirectChangeInHistory(id, 'cancelled-by-hand');
  }, 120_000);

  it('the history records the direct change as it happens, before anyone edits the record', async () => {
    const id = newRecordId('e2e-direct-recorded');
    await seedWithHistory(id);

    await withLiveCollection(documents => documents.updateOne({ _id: id }, { $set: { value: 'migrated' } }));

    await waitUntilAsync(async () => directWriteEntriesOf(entriesOf(await getServerAudit(id)) as ServerAuditEntry<E2eTestRecord>[]).length > 0, 'the direct change is in the history', 30_000);
    await expectDirectChangeInHistory(id, 'migrated');
  }, 120_000);

  it('a direct change made while the server is stopped (the documented route: $unset _meta) is kept by the next edit', async () => {
    const id = newRecordId('e2e-direct-kept-stopped');
    const edited = await seedWithHistory(id);

    await useServer().stopServer();
    await withLiveCollection(documents => documents.updateOne({ _id: id }, { $set: { value: 'fixed-while-stopped' }, $unset: { _meta: '' } }, { writeConcern: { j: true } }));
    await useServer().restartServer();

    const a = useClient('a');
    await waitUntilAsync(async () => a.getIsConnected(), 'A is connected again', 60_000);
    await waitForLocal(a, id, record => record?.value === 'fixed-while-stopped', 'A holds the direct change');
    await a.upsert({ ...edited, value: 'fixed-while-stopped', name: 'edited after the restart' });
    await waitForStored(id, stored => stored?.name === 'edited after the restart', 'the edit is stored');
    await waitForAllClientsIdle([a]);

    expect((await readStored(id))?.value, 'the direct change is kept').toBe('fixed-while-stopped');
    await expectDirectChangeInHistory(id, 'fixed-while-stopped');
  }, 180_000);

  it('a direct change made while the server is stopped, without the documented $unset, is still kept by the next edit', async () => {
    const id = newRecordId('e2e-direct-kept-stopped-no-unset');
    const edited = await seedWithHistory(id);
    const b = useClient('b');

    await b.disconnect();
    await useServer().stopServer();
    await withLiveCollection(documents => documents.updateOne({ _id: id }, { $set: { value: 'fixed-while-stopped' } }, { writeConcern: { j: true } }));
    await useServer().restartServer();

    // B still holds the old copy (its stored hash was never cleared), edits another field on it, then comes back.
    await b.upsert({ ...edited, name: 'edited after the restart' });
    await b.reconnect();
    await waitForStored(id, stored => stored?.name === 'edited after the restart', 'the edit is stored');
    await waitForLocal(b, id, record => record?.value === 'fixed-while-stopped' && record.name === 'edited after the restart', 'B holds both changes');
    await waitForAllClientsIdle([b]);

    expect((await readStored(id))?.value, 'the direct change is kept').toBe('fixed-while-stopped');
    await expectDirectChangeInHistory(id, 'fixed-while-stopped');
  }, 180_000);

  it('a later app edit of the same field still wins over the direct change', async () => {
    const a = useClient('a');
    const id = newRecordId('e2e-direct-overwritten');
    const edited = await seedWithHistory(id);

    await withLiveCollection(documents => documents.updateOne({ _id: id }, { $set: { value: 'cancelled-by-hand' } }));
    await waitForLocal(a, id, record => record?.value === 'cancelled-by-hand', 'A holds the direct change');
    await pause(SERVER_SEES_WRITE_MS);

    await a.upsert({ ...edited, value: 'booked-again' });
    await waitForStored(id, stored => stored?.value === 'booked-again', 'the later edit is stored');
    await waitForAllClientsIdle([a]);

    await expectDirectChangeInHistory(id, 'cancelled-by-hand');
  }, 120_000);

  it('edits made only through mxdb are never taken for direct changes', async () => {
    const a = useClient('a');
    const b = useClient('b');
    const id = newRecordId('e2e-direct-control');
    const edited = await seedWithHistory(id);

    await a.upsert({ ...edited, value: 'edited-in-the-app', name: null, tags: ['one', 'two'], metadata: { count: 2, tag: null } });
    await waitForLocal(b, id, record => record?.value === 'edited-in-the-app', 'B holds A\'s edit');
    await b.upsert({ ...edited, value: 'edited-in-the-app', name: 'b', tags: ['one'], metadata: { count: 3, tag: 'x' } });
    await waitForStored(id, stored => stored?.name === 'b', 'B\'s edit is stored');
    await waitForAllClientsIdle([a, b]);
    await pause(SERVER_SEES_WRITE_MS);

    expect(directWriteEntriesOf(entriesOf(await getServerAudit(id)) as ServerAuditEntry<E2eTestRecord>[])).toEqual([]);
  }, 120_000);
});
