import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@anupheaus/common'; // installs array extensions (.ids()) and Object.clone used by the sync engine
import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import { AuditEntryType, defineCollection } from '../common';
import type { AuditEntry, AuditOf } from '../common/auditor';
import { hashRecord } from '../common/auditor/hash';
import {
  ServerDispatcher,
  type MXDBRecordCursors,
  type MXDBSyncEngineResponse,
} from '../common/sync-engine';
import { ServerToClientSynchronisation } from './ServerToClientSynchronisation';
import type { ServerDb } from './providers/db/ServerDb';

/**
 * Contract tests for the per-connection server→client adapter.
 *
 * The external boundaries are stubbed: `emitS2C` (the socket emit to the connected client) and
 * `getDb()` (MongoDB). Everything in between — cursor building, the real ServerDispatcher and its
 * filter bookkeeping — runs for real, so every assertion is about what the CLIENT is sent.
 */

// ─── Fixtures ──────────────────────────────────────────────────────────────────

interface Widget extends MXDBRecord {
  id: string;
  name: string;
}

const AUDITED = 's2cWidgets';
const NON_AUDITED = 's2cNoAuditWidgets';
const UNREGISTERED = 's2cNotThisClientsCollection';

const auditedCollection = defineCollection<Widget>({ name: AUDITED, indexes: [] });
const nonAuditedCollection = defineCollection<Widget>({ name: NON_AUDITED, indexes: [], disableAudit: true });

/** Deterministic, lexically ordered ULID-like ids — ordering is all the sync engine relies on. */
function entryId(sequence: number): string {
  return `01J${String(sequence).padStart(23, '0')}`;
}

function widget(id: string, name: string): Widget {
  return { id, name };
}

function createdEntry(record: Widget, sequence: number): AuditEntry<Widget> {
  return { type: AuditEntryType.Created, id: entryId(sequence), record: { ...record } } as AuditEntry<Widget>;
}

function updatedEntry(sequence: number): AuditEntry<Widget> {
  return { type: AuditEntryType.Updated, id: entryId(sequence), ops: [] } as unknown as AuditEntry<Widget>;
}

function deletedEntry(sequence: number): AuditEntry<Widget> {
  return { type: AuditEntryType.Deleted, id: entryId(sequence) } as AuditEntry<Widget>;
}

interface MockLogger {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  silly: ReturnType<typeof vi.fn>;
  createSubLogger: ReturnType<typeof vi.fn>;
}

function createMockLogger(): MockLogger {
  const logger: MockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    silly: vi.fn(),
    createSubLogger: vi.fn(),
  };
  logger.createSubLogger.mockReturnValue(logger);
  return logger;
}

// ─── Fake MongoDB (external boundary) ──────────────────────────────────────────

interface FakeStore {
  records: Map<string, Widget>;
  audits: Map<string, AuditOf<Widget>>;
}

type GetAuditFn = (ids: string | string[]) => Promise<AuditOf<Widget> | AuditOf<Widget>[] | undefined>;

interface FakeCollection {
  get: ReturnType<typeof vi.fn<(ids: string[]) => Promise<Widget[]>>>;
  getAudit: ReturnType<typeof vi.fn<GetAuditFn>>;
}

function createFakeCollection(store: FakeStore): FakeCollection {
  const readAudit = (id: string): AuditOf<Widget> | undefined => {
    const audit = store.audits.get(id);
    return audit == null ? undefined : { id: audit.id, entries: [...audit.entries] };
  };
  return {
    get: vi.fn(async (ids: string[]) => ids
      .map(id => store.records.get(id))
      .filter((record): record is Widget => record != null)
      .map(record => ({ ...record }))),
    getAudit: vi.fn<GetAuditFn>(async ids => (Array.isArray(ids)
      ? ids.map(readAudit).filter((audit): audit is AuditOf<Widget> => audit != null)
      : readAudit(ids))),
  };
}

// ─── Fake client (external boundary: the socket emit) ─────────────────────────

type Responder = (payload: MXDBRecordCursors) => Promise<MXDBSyncEngineResponse>;

/** The client applies everything it is sent. */
const acknowledgeAll: Responder = async payload => payload.map(({ collectionName, records }) => ({
  collectionName,
  successfulRecordIds: records.map(cursor => ('recordId' in cursor ? cursor.recordId : cursor.record.id)),
}));

interface Harness {
  s2c: ServerToClientSynchronisation;
  store: FakeStore;
  collection: FakeCollection;
  logger: MockLogger;
  getDb: ReturnType<typeof vi.fn>;
  /** Every payload emitted to the client, in emit order. */
  emitted: MXDBRecordCursors[];
  /** Swap how the client answers subsequent emits. */
  setResponder(responder: Responder): void;
  /** Seed live record + audit on the server. */
  seed(record: Widget, entries: AuditEntry<Widget>[]): void;
  /** Push a record authoritatively and wait for the client's ack to be processed, so the client "holds" it. */
  deliverToClient(record: Widget): Promise<void>;
}

interface HarnessOptions {
  collectionName?: string;
  /** Make `db.use()` throw (collection not registered on this db). */
  useThrows?: boolean;
}

function createHarness({ collectionName = AUDITED, useThrows = false }: HarnessOptions = {}): Harness {
  const store: FakeStore = { records: new Map(), audits: new Map() };
  const collection = createFakeCollection(store);
  const logger = createMockLogger();
  const emitted: MXDBRecordCursors[] = [];
  let responder: Responder = acknowledgeAll;

  const fakeDb = {
    use: vi.fn((_name: string) => {
      if (useThrows) throw new Error('collection not registered');
      return collection;
    }),
  } as unknown as ServerDb;
  const getDb = vi.fn(() => fakeDb);

  const s2c = new ServerToClientSynchronisation({
    emitS2C: async payload => {
      emitted.push(structuredClone(payload));
      return responder(payload);
    },
    getDb,
    collections: [auditedCollection, nonAuditedCollection],
    logger: logger as unknown as Logger,
    clientId: 'client-1',
  });

  const seed = (record: Widget, entries: AuditEntry<Widget>[]): void => {
    store.records.set(record.id, { ...record });
    store.audits.set(record.id, { id: record.id, entries } as AuditOf<Widget>);
  };

  return {
    s2c, store, collection, logger, getDb, emitted,
    setResponder: next => { responder = next; },
    seed,
    deliverToClient: async record => {
      await s2c.pushActive(collectionName, [record]);
      await flushMicrotasks();
    },
  };
}

/** Drain the microtask queue so the dispatcher processes a resolved emit. Timer-free. */
async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 50; tick++) await Promise.resolve();
}

/** Controlled client response: the emit stays in flight until the test resolves it. */
function createDeferredResponder(): { responder: Responder; resolveNext(): void } {
  const pending: Array<() => void> = [];
  return {
    responder: payload => new Promise(resolve => { pending.push(() => { void acknowledgeAll(payload).then(resolve); }); }),
    resolveNext: () => { pending.shift()?.(); },
  };
}

// ─── No-op instance ────────────────────────────────────────────────────────────

describe('ServerToClientSynchronisation — no-op instance', () => {
  const createNoOp = () => ServerToClientSynchronisation.createNoOp([auditedCollection], createMockLogger() as unknown as Logger);

  it('reports itself as a no-op', () => {
    expect(createNoOp().isNoOp).toBe(true);
  });

  it('throws when the dispatcher is requested, because no-op instances have none', () => {
    expect(() => createNoOp().dispatcher).toThrow('ServerToClientSynchronisation: dispatcher unavailable on no-op instance');
  });

  const noOpOperations: Array<[string, (s2c: ServerToClientSynchronisation) => Promise<void>]> = [
    ['pushActive', s2c => s2c.pushActive(AUDITED, [widget('w1', 'a')])],
    ['pushDeletes', s2c => s2c.pushDeletes(AUDITED, ['w1'])],
    ['onDbChange upsert', s2c => s2c.onDbChange({ type: 'upsert', collectionName: AUDITED, records: [widget('w1', 'a')] })],
    ['onDbChange delete', s2c => s2c.onDbChange({ type: 'delete', collectionName: AUDITED, recordIds: ['w1'] })],
  ];

  // The no-op's getDb throws if touched, so resolving cleanly proves no DB read and no emit happened.
  it.each(noOpOperations)('%s resolves without touching the database', async (_name, operation) => {
    await expect(operation(createNoOp())).resolves.toBeUndefined();
  });

  it('tolerates pause, resume and close without a dispatcher', () => {
    const s2c = createNoOp();
    expect(() => { s2c.pause(); s2c.resume(); s2c.close(); }).not.toThrow();
  });
});

// ─── Live instance basics ──────────────────────────────────────────────────────

describe('ServerToClientSynchronisation — live instance', () => {
  it('is not a no-op', () => {
    expect(createHarness().s2c.isNoOp).toBe(false);
  });

  it('exposes a ServerDispatcher for the C2S receiver to share', () => {
    expect(createHarness().s2c.dispatcher).toBeInstanceOf(ServerDispatcher);
  });
});

// ─── pushActive (authoritative) ───────────────────────────────────────────────

describe('ServerToClientSynchronisation.pushActive', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('sends the record with its last audit entry id and content hash', async () => {
    const record = widget('w1', 'current');
    harness.seed(record, [createdEntry(widget('w1', 'original'), 1), updatedEntry(2)]);

    await harness.s2c.pushActive(AUDITED, [record]);

    expect(harness.emitted).toEqual([[{
      collectionName: AUDITED,
      records: [{ record, lastAuditEntryId: entryId(2), hash: await hashRecord(record) }],
    }]]);
  });

  it('sends the database copy of the record, not the possibly stale copy it was given', async () => {
    harness.seed(widget('w1', 'fresh'), [createdEntry(widget('w1', 'fresh'), 1)]);

    await harness.s2c.pushActive(AUDITED, [widget('w1', 'stale')]);

    expect(harness.emitted[0]![0]!.records[0]).toMatchObject({ record: { id: 'w1', name: 'fresh' } });
  });

  it('sends every record of a batch in a single emit', async () => {
    harness.seed(widget('w1', 'a'), [createdEntry(widget('w1', 'a'), 1)]);
    harness.seed(widget('w2', 'b'), [createdEntry(widget('w2', 'b'), 2)]);

    await harness.s2c.pushActive(AUDITED, [widget('w1', 'a'), widget('w2', 'b')]);

    expect(harness.emitted).toHaveLength(1);
    expect(harness.emitted[0]![0]!.records.map(cursor => ('record' in cursor ? cursor.record.id : cursor.recordId))).toEqual(['w1', 'w2']);
  });

  it('sends a live record that has no audit with an empty audit anchor', async () => {
    harness.store.records.set('w1', widget('w1', 'unaudited'));

    await harness.s2c.pushActive(AUDITED, [widget('w1', 'unaudited')]);

    expect(harness.emitted[0]![0]!.records[0]).toMatchObject({ record: { id: 'w1' }, lastAuditEntryId: '' });
  });

  it('does not send a record whose audit says it is deleted (tombstoned records never re-reach the client)', async () => {
    harness.seed(widget('w1', 'ghost'), [createdEntry(widget('w1', 'ghost'), 1), deletedEntry(2)]);

    await harness.s2c.pushActive(AUDITED, [widget('w1', 'ghost')]);

    expect(harness.emitted).toEqual([]);
  });

  it('does not send a record that has an audit but no live document', async () => {
    harness.store.audits.set('w1', { id: 'w1', entries: [createdEntry(widget('w1', 'x'), 1)] } as AuditOf<Widget>);

    await harness.s2c.pushActive(AUDITED, [widget('w1', 'x')]);

    expect(harness.emitted).toEqual([]);
  });

  it('does not emit or read the database for an empty record list', async () => {
    await harness.s2c.pushActive(AUDITED, []);

    expect(harness.emitted).toEqual([]);
    expect(harness.getDb).not.toHaveBeenCalled();
  });

  it('ignores collections this client was not configured with', async () => {
    harness.seed(widget('w1', 'a'), [createdEntry(widget('w1', 'a'), 1)]);

    await harness.s2c.pushActive(UNREGISTERED, [widget('w1', 'a')]);

    expect(harness.emitted).toEqual([]);
  });

  it('resolves without emitting when the database does not know the collection', async () => {
    const throwingHarness = createHarness({ useThrows: true });

    await throwingHarness.s2c.pushActive(AUDITED, [widget('w1', 'a')]);

    expect(throwingHarness.emitted).toEqual([]);
  });

  it('sends a non-audited record with an empty anchor and never reads an audit', async () => {
    harness.store.records.set('n1', widget('n1', 'plain'));

    await harness.s2c.pushActive(NON_AUDITED, [widget('n1', 'plain')]);

    expect(harness.emitted).toEqual([[{
      collectionName: NON_AUDITED,
      records: [{ record: widget('n1', 'plain'), lastAuditEntryId: '', hash: await hashRecord(widget('n1', 'plain')) }],
    }]]);
    expect(harness.collection.getAudit).not.toHaveBeenCalled();
  });
});

// ─── pushActive: pair-consistency under concurrent writes ─────────────────────

describe('ServerToClientSynchronisation.pushActive — concurrent writes while building the cursor', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
    harness.seed(widget('w1', 'v1'), [createdEntry(widget('w1', 'v1'), 1)]);
  });

  /** A write that lands in the DB: new record content + a new audit entry. */
  const writeUpdate = (name: string, sequence: number): void => {
    harness.store.records.set('w1', widget('w1', name));
    harness.store.audits.get('w1')!.entries.push(updatedEntry(sequence));
  };

  /** Run `sideEffect` right AFTER the Nth getAudit call has read its (pre-write) state. */
  const afterGetAuditCall = (callNumber: number, sideEffect: () => void): void => {
    const original = harness.collection.getAudit.getMockImplementation()!;
    let calls = 0;
    harness.collection.getAudit.mockImplementation(async ids => {
      calls++;
      const result = await original(ids);
      if (calls === callNumber) sideEffect();
      return result;
    });
  };

  it('sends the record and anchor of the same (post-write) state when a write lands mid-build', async () => {
    afterGetAuditCall(1, () => writeUpdate('v2', 2));

    await harness.s2c.pushActive(AUDITED, [widget('w1', 'v1')]);

    expect(harness.emitted[0]![0]!.records).toEqual([
      { record: widget('w1', 'v2'), lastAuditEntryId: entryId(2), hash: await hashRecord(widget('w1', 'v2')) },
    ]);
  });

  it('does not send the record when it is deleted while the build is being retried', async () => {
    afterGetAuditCall(1, () => writeUpdate('v2', 2));
    // Call 3 is the first per-record retry read; a delete lands before it reads.
    const inconsistentImpl = harness.collection.getAudit.getMockImplementation()!;
    let calls = 0;
    harness.collection.getAudit.mockImplementation(async ids => {
      calls++;
      if (calls === 3) harness.store.audits.get('w1')!.entries.push(deletedEntry(3));
      return inconsistentImpl(ids);
    });

    await harness.s2c.pushActive(AUDITED, [widget('w1', 'v1')]);

    expect(harness.emitted).toEqual([]);
  });

  it('does not send the record when it is deleted between the reads of a retry', async () => {
    afterGetAuditCall(1, () => writeUpdate('v2', 2));
    // Call 3 is the retry's first audit read; the delete lands right after it, before the second.
    afterGetAuditCall(3, () => harness.store.audits.get('w1')!.entries.push(deletedEntry(3)));

    await harness.s2c.pushActive(AUDITED, [widget('w1', 'v1')]);

    expect(harness.emitted).toEqual([]);
  });

  it('does not send the record when its audit keeps changing on every read (never consistent)', async () => {
    let sequence = 2;
    const original = harness.collection.getAudit.getMockImplementation()!;
    harness.collection.getAudit.mockImplementation(async ids => {
      const result = await original(ids);
      writeUpdate(`v${sequence}`, sequence++);
      return result;
    });

    await harness.s2c.pushActive(AUDITED, [widget('w1', 'v1')]);

    expect(harness.emitted).toEqual([]);
  });

  const retryFailures: Array<[string, Error, 'warn' | 'error']> = [
    ['a transient Mongo close error', Object.assign(new Error('client was closed'), { name: 'MongoClientClosedError' }), 'warn'],
    ['an unexpected error', new Error('disk on fire'), 'error'],
  ];

  it.each(retryFailures)('still sends the other records of the batch when a retry read fails with %s', async (_label, failure) => {
    harness.seed(widget('w2', 'steady'), [createdEntry(widget('w2', 'steady'), 10)]);
    afterGetAuditCall(1, () => writeUpdate('v2', 2));
    const original = harness.collection.getAudit.getMockImplementation()!;
    harness.collection.getAudit.mockImplementation(async ids => {
      if (!Array.isArray(ids)) throw failure; // per-record retry read for w1
      return original(ids);
    });

    await harness.s2c.pushActive(AUDITED, [widget('w1', 'v1'), widget('w2', 'steady')]);

    expect(harness.emitted[0]![0]!.records).toEqual([
      { record: widget('w2', 'steady'), lastAuditEntryId: entryId(10), hash: await hashRecord(widget('w2', 'steady')) },
    ]);
  });

  it.each(retryFailures)('logs a retry read failure caused by %s at %s level', async (_label, failure, level) => {
    afterGetAuditCall(1, () => writeUpdate('v2', 2));
    const original = harness.collection.getAudit.getMockImplementation()!;
    harness.collection.getAudit.mockImplementation(async ids => {
      if (!Array.isArray(ids)) throw failure;
      return original(ids);
    });

    await harness.s2c.pushActive(AUDITED, [widget('w1', 'v1')]);

    expect(harness.logger[level]).toHaveBeenCalledWith(
      expect.stringContaining('[s2c] #buildAndPush'),
      expect.objectContaining({ collectionName: AUDITED, recordId: 'w1' }),
    );
  });
});

// ─── onDbChange (change-stream fan-out) ───────────────────────────────────────

describe('ServerToClientSynchronisation.onDbChange', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('sends an update for a record the client already holds', async () => {
    harness.seed(widget('w1', 'v1'), [createdEntry(widget('w1', 'v1'), 1)]);
    await harness.deliverToClient(widget('w1', 'v1'));
    harness.seed(widget('w1', 'v2'), [createdEntry(widget('w1', 'v1'), 1), updatedEntry(2)]);

    await harness.s2c.onDbChange({ type: 'upsert', collectionName: AUDITED, records: [widget('w1', 'v2')] });

    expect(harness.emitted[1]).toEqual([{
      collectionName: AUDITED,
      records: [{ record: widget('w1', 'v2'), lastAuditEntryId: entryId(2), hash: await hashRecord(widget('w1', 'v2')) }],
    }]);
  });

  it('does not bootstrap a record the client has never been sent', async () => {
    harness.seed(widget('w1', 'v1'), [createdEntry(widget('w1', 'v1'), 1)]);

    await harness.s2c.onDbChange({ type: 'upsert', collectionName: AUDITED, records: [widget('w1', 'v1')] });
    await flushMicrotasks();

    expect(harness.emitted).toEqual([]);
  });

  it('does not deliver change-stream updates on a fresh (reconnected) instance until the record is pushed authoritatively', async () => {
    harness.seed(widget('w1', 'v1'), [createdEntry(widget('w1', 'v1'), 1)]);
    await harness.deliverToClient(widget('w1', 'v1'));
    const reconnected = createHarness();
    reconnected.seed(widget('w1', 'v2'), [createdEntry(widget('w1', 'v1'), 1), updatedEntry(2)]);

    await reconnected.s2c.onDbChange({ type: 'upsert', collectionName: AUDITED, records: [widget('w1', 'v2')] });
    await flushMicrotasks();

    expect(reconnected.emitted).toEqual([]);
  });

  it('does not resend an update the client already has (same anchor and hash)', async () => {
    harness.seed(widget('w1', 'v1'), [createdEntry(widget('w1', 'v1'), 1)]);
    await harness.deliverToClient(widget('w1', 'v1'));

    await harness.s2c.onDbChange({ type: 'upsert', collectionName: AUDITED, records: [widget('w1', 'v1')] });
    await flushMicrotasks();

    expect(harness.emitted).toHaveLength(1);
  });

  it('sends a delete cursor anchored at the Deleted audit entry for a record the client holds', async () => {
    harness.seed(widget('w1', 'v1'), [createdEntry(widget('w1', 'v1'), 1)]);
    await harness.deliverToClient(widget('w1', 'v1'));
    harness.store.audits.get('w1')!.entries.push(deletedEntry(5));
    harness.store.records.delete('w1');

    await harness.s2c.onDbChange({ type: 'delete', collectionName: AUDITED, recordIds: ['w1'] });

    expect(harness.emitted[1]).toEqual([{ collectionName: AUDITED, records: [{ recordId: 'w1', lastAuditEntryId: entryId(5) }] }]);
  });

  it('does not send a delete for a record the client never held', async () => {
    harness.store.audits.set('w1', { id: 'w1', entries: [createdEntry(widget('w1', 'x'), 1), deletedEntry(2)] } as AuditOf<Widget>);

    await harness.s2c.onDbChange({ type: 'delete', collectionName: AUDITED, recordIds: ['w1'] });
    await flushMicrotasks();

    expect(harness.emitted).toEqual([]);
  });

  it('never sends updates for a record after the client acknowledged its deletion (delete is final)', async () => {
    harness.seed(widget('w1', 'v1'), [createdEntry(widget('w1', 'v1'), 1)]);
    await harness.deliverToClient(widget('w1', 'v1'));
    await harness.s2c.onDbChange({ type: 'delete', collectionName: AUDITED, recordIds: ['w1'] });
    await flushMicrotasks();
    // An update lands after the delete (the audit is NOT marked deleted in this fake, so only the
    // dispatcher's delete-is-final bookkeeping can stop it).
    harness.seed(widget('w1', 'v9'), [createdEntry(widget('w1', 'v1'), 1), updatedEntry(9)]);

    await harness.s2c.onDbChange({ type: 'upsert', collectionName: AUDITED, records: [widget('w1', 'v9')] });
    await flushMicrotasks();

    expect(harness.emitted).toHaveLength(2);
  });

  it('sends a delete with an empty anchor when the record has no audit', async () => {
    harness.store.records.set('w1', widget('w1', 'v1'));
    await harness.deliverToClient(widget('w1', 'v1'));
    harness.store.records.delete('w1');

    await harness.s2c.onDbChange({ type: 'delete', collectionName: AUDITED, recordIds: ['w1'] });

    expect(harness.emitted[1]).toEqual([{ collectionName: AUDITED, records: [{ recordId: 'w1', lastAuditEntryId: '' }] }]);
  });

  it('sends a delete with an empty anchor for a non-audited collection without reading any audit', async () => {
    const nonAudited = createHarness({ collectionName: NON_AUDITED });
    nonAudited.store.records.set('n1', widget('n1', 'plain'));
    await nonAudited.deliverToClient(widget('n1', 'plain'));

    await nonAudited.s2c.onDbChange({ type: 'delete', collectionName: NON_AUDITED, recordIds: ['n1'] });

    expect(nonAudited.emitted[1]).toEqual([{ collectionName: NON_AUDITED, records: [{ recordId: 'n1', lastAuditEntryId: '' }] }]);
    expect(nonAudited.collection.getAudit).not.toHaveBeenCalled();
  });

  const unrelatedEvents = [
    { type: 'upsert' as const, collectionName: UNREGISTERED, records: [widget('w1', 'v2')] },
    { type: 'delete' as const, collectionName: UNREGISTERED, recordIds: ['w1'] },
  ];

  it.each(unrelatedEvents)('ignores a $type event for a collection this client was not configured with', async event => {
    await harness.s2c.onDbChange(event);
    await flushMicrotasks();

    expect(harness.getDb).not.toHaveBeenCalled();
  });

  it('resolves without emitting a delete when the database does not know the collection', async () => {
    const throwingHarness = createHarness({ useThrows: true });

    await throwingHarness.s2c.onDbChange({ type: 'delete', collectionName: AUDITED, recordIds: ['w1'] });

    expect(throwingHarness.emitted).toEqual([]);
  });

  const deleteReadFailures: Array<[string, Error, 'warn' | 'error']> = [
    ['a transient Mongo close error', Object.assign(new Error('pool gone'), { name: 'MongoPoolClosedError' }), 'warn'],
    ['an unexpected error', new Error('corrupted audit'), 'error'],
  ];

  it.each(deleteReadFailures)('still sends the other deletes of the batch when one audit read fails with %s', async (_label, failure) => {
    harness.seed(widget('w1', 'a'), [createdEntry(widget('w1', 'a'), 1)]);
    harness.seed(widget('w2', 'b'), [createdEntry(widget('w2', 'b'), 2)]);
    await harness.s2c.pushActive(AUDITED, [widget('w1', 'a'), widget('w2', 'b')]);
    await flushMicrotasks();
    const original = harness.collection.getAudit.getMockImplementation()!;
    harness.collection.getAudit.mockImplementation(async ids => {
      if (ids === 'w1') throw failure;
      return original(ids);
    });

    await harness.s2c.onDbChange({ type: 'delete', collectionName: AUDITED, recordIds: ['w1', 'w2'] });

    expect(harness.emitted[1]).toEqual([{ collectionName: AUDITED, records: [{ recordId: 'w2', lastAuditEntryId: entryId(2) }] }]);
  });

  it.each(deleteReadFailures)('logs a delete audit read failure caused by %s at %s level', async (_label, failure, level) => {
    harness.collection.getAudit.mockRejectedValue(failure);

    await harness.s2c.onDbChange({ type: 'delete', collectionName: AUDITED, recordIds: ['w1'] });

    expect(harness.logger[level]).toHaveBeenCalledWith(
      expect.stringContaining('[s2c] #buildDeleteCursors'),
      expect.objectContaining({ collectionName: AUDITED, recordId: 'w1' }),
    );
  });
});

// ─── pushDeletes (reconcile path) ─────────────────────────────────────────────

describe('ServerToClientSynchronisation.pushDeletes', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('sends delete cursors for records the client holds', async () => {
    harness.seed(widget('w1', 'v1'), [createdEntry(widget('w1', 'v1'), 1)]);
    await harness.deliverToClient(widget('w1', 'v1'));
    harness.store.audits.get('w1')!.entries.push(deletedEntry(3));

    await harness.s2c.pushDeletes(AUDITED, ['w1']);

    expect(harness.emitted[1]).toEqual([{ collectionName: AUDITED, records: [{ recordId: 'w1', lastAuditEntryId: entryId(3) }] }]);
  });

  it('does not send deletes for records the client never held', async () => {
    harness.store.audits.set('w1', { id: 'w1', entries: [createdEntry(widget('w1', 'x'), 1), deletedEntry(2)] } as AuditOf<Widget>);

    await harness.s2c.pushDeletes(AUDITED, ['w1']);
    await flushMicrotasks();

    expect(harness.emitted).toEqual([]);
  });

  it('does not read the database for an empty id list', async () => {
    await harness.s2c.pushDeletes(AUDITED, []);

    expect(harness.getDb).not.toHaveBeenCalled();
  });

  it('ignores collections this client was not configured with', async () => {
    await harness.s2c.pushDeletes(UNREGISTERED, ['w1']);

    expect(harness.getDb).not.toHaveBeenCalled();
  });

  it('does not emit when every delete cursor fails to build', async () => {
    harness.seed(widget('w1', 'v1'), [createdEntry(widget('w1', 'v1'), 1)]);
    await harness.deliverToClient(widget('w1', 'v1'));
    harness.collection.getAudit.mockRejectedValue(new Error('boom'));

    await harness.s2c.pushDeletes(AUDITED, ['w1']);
    await flushMicrotasks();

    expect(harness.emitted).toHaveLength(1);
  });
});

// ─── Lifecycle: close / pause / resume / ordering ─────────────────────────────

describe('ServerToClientSynchronisation — lifecycle and ordering', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
    harness.seed(widget('w1', 'a'), [createdEntry(widget('w1', 'a'), 1)]);
    harness.seed(widget('w2', 'b'), [createdEntry(widget('w2', 'b'), 2)]);
    harness.seed(widget('w3', 'c'), [createdEntry(widget('w3', 'c'), 3)]);
  });

  const operationsAfterClose: Array<[string, (s2c: ServerToClientSynchronisation) => Promise<void>]> = [
    ['pushActive', s2c => s2c.pushActive(AUDITED, [widget('w1', 'a')])],
    ['pushDeletes', s2c => s2c.pushDeletes(AUDITED, ['w1'])],
    ['onDbChange upsert', s2c => s2c.onDbChange({ type: 'upsert', collectionName: AUDITED, records: [widget('w1', 'a')] })],
    ['onDbChange delete', s2c => s2c.onDbChange({ type: 'delete', collectionName: AUDITED, recordIds: ['w1'] })],
  ];

  it.each(operationsAfterClose)('%s after close neither reads the database nor emits', async (_name, operation) => {
    harness.s2c.close();

    await operation(harness.s2c);
    await flushMicrotasks();

    expect(harness.getDb).not.toHaveBeenCalled();
    expect(harness.emitted).toEqual([]);
  });

  it('can be closed more than once', () => {
    harness.s2c.close();

    expect(() => harness.s2c.close()).not.toThrow();
  });

  it('does not emit records queued behind an in-flight emit once closed (disconnect mid-dispatch)', async () => {
    const deferred = createDeferredResponder();
    harness.setResponder(deferred.responder);
    await harness.s2c.pushActive(AUDITED, [widget('w1', 'a')]);
    await harness.s2c.pushActive(AUDITED, [widget('w2', 'b')]);

    harness.s2c.close();
    deferred.resolveNext();
    await flushMicrotasks();

    expect(harness.emitted).toHaveLength(1);
  });

  it('coalesces pushes made while an emit is in flight into one follow-up emit, in order', async () => {
    const deferred = createDeferredResponder();
    harness.setResponder(deferred.responder);
    await harness.s2c.pushActive(AUDITED, [widget('w1', 'a')]);
    await harness.s2c.pushActive(AUDITED, [widget('w2', 'b')]);
    await harness.s2c.pushActive(AUDITED, [widget('w3', 'c')]);

    deferred.resolveNext();
    await flushMicrotasks();

    expect(harness.emitted.map(payload => payload[0]!.records.map(cursor => ('record' in cursor ? cursor.record.id : cursor.recordId))))
      .toEqual([['w1'], ['w2', 'w3']]);
  });

  it('holds pushes while paused', async () => {
    harness.s2c.pause();

    await harness.s2c.pushActive(AUDITED, [widget('w1', 'a')]);
    await flushMicrotasks();

    expect(harness.emitted).toEqual([]);
  });

  it('flushes held pushes when resumed', async () => {
    harness.s2c.pause();
    await harness.s2c.pushActive(AUDITED, [widget('w1', 'a')]);

    harness.s2c.resume();

    expect(harness.emitted).toHaveLength(1);
  });
});

// ─── Emit failures ────────────────────────────────────────────────────────────

describe('ServerToClientSynchronisation — emit failures', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = createHarness();
    harness.seed(widget('w1', 'a'), [createdEntry(widget('w1', 'a'), 1)]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The socket layer surfaces a paused client as a plain Error with this sentinel message. */
  const pausedOnce = (): Responder => {
    let calls = 0;
    return async payload => {
      calls++;
      if (calls === 1) throw new Error('MXDB_SYNC_PAUSED');
      return acknowledgeAll(payload);
    };
  };

  it('re-sends the same records once the retry interval elapses when the client reports it is paused', async () => {
    harness.setResponder(pausedOnce());
    await harness.s2c.pushActive(AUDITED, [widget('w1', 'a')]);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(250);

    expect(harness.emitted).toHaveLength(2);
    expect(harness.emitted[1]).toEqual(harness.emitted[0]);
  });

  it('does not re-send before the retry interval has elapsed', async () => {
    harness.setResponder(pausedOnce());
    await harness.s2c.pushActive(AUDITED, [widget('w1', 'a')]);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(249);

    expect(harness.emitted).toHaveLength(1);
  });

  it('does not treat a paused client as an emit failure worth warning about', async () => {
    harness.setResponder(pausedOnce());
    await harness.s2c.pushActive(AUDITED, [widget('w1', 'a')]);
    await flushMicrotasks();

    expect(harness.logger.warn).not.toHaveBeenCalledWith('S2C emitS2C threw (likely client disconnect race)', expect.anything());
  });

  it('does not retry after close when the client reported it was paused', async () => {
    harness.setResponder(pausedOnce());
    await harness.s2c.pushActive(AUDITED, [widget('w1', 'a')]);
    await flushMicrotasks();

    harness.s2c.close();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.emitted).toHaveLength(1);
  });

  describe('when the emit itself fails (e.g. the client disconnected mid-push)', () => {
    const failingOnce = (): Responder => {
      let calls = 0;
      return async payload => {
        calls++;
        if (calls === 1) throw new Error('socket has been disconnected');
        return acknowledgeAll(payload);
      };
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

    beforeEach(() => {
      unhandled.length = 0;
      process.on('unhandledRejection', onUnhandled);
    });

    afterEach(() => {
      process.off('unhandledRejection', onUnhandled);
    });

    it('does not crash the server with an unhandled rejection', async () => {
      harness.setResponder(failingOnce());

      await harness.s2c.pushActive(AUDITED, [widget('w1', 'a')]);
      await flushMicrotasks();
      await vi.dynamicImportSettled(); // yields a macrotask so Node can report unhandled rejections

      expect(unhandled).toEqual([]);
    });

    it('re-sends the record after the retry interval if the client is still connected', async () => {
      harness.setResponder(failingOnce());
      await harness.s2c.pushActive(AUDITED, [widget('w1', 'a')]);
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(250);

      expect(harness.emitted).toHaveLength(2);
      expect(harness.emitted[1]).toEqual(harness.emitted[0]);
    });

    it('stops re-sending once the sync is closed on disconnect', async () => {
      harness.setResponder(async () => { throw new Error('socket has been disconnected'); });
      await harness.s2c.pushActive(AUDITED, [widget('w1', 'a')]);
      await flushMicrotasks();

      harness.s2c.close();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(harness.emitted).toHaveLength(1);
    });
  });
});
