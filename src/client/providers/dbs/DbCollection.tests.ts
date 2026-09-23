// Behavioural tests for DbCollection's public API, run against the real in-process SQLite runner
// (SqliteWorkerClient inline mode — no Worker in Node). Persistence is verified by reloading the
// in-memory cache from SQLite via reloadFromWorker().
import { describe, it, expect, vi } from 'vitest';
import type { Logger, Record } from '@anupheaus/common';
import { ulid } from 'ulidx';
import { SqliteWorkerClient } from '../../db-worker/SqliteWorkerClient';
import { AUDIT_TABLE_SUFFIX, LIVE_TABLE_SUFFIX, buildTableDDL, q } from '../../db-worker/buildTableDDL';
import { AuditEntryType } from '../../../common';
import type { MXDBCollectionConfig } from '../../../common/models';
import { DbCollection } from './DbCollection';
import type { MXDBCollectionEvent } from './models';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

interface TestRecord extends Record {
  id: string;
  name: string;
  value?: number;
}

interface CollectionFixture {
  collection: DbCollection<TestRecord>;
  worker: SqliteWorkerClient;
}

interface LoggerStub {
  logger: Logger;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

const COLLECTION_NAME = 'things';
const LIVE_TABLE = q(`${COLLECTION_NAME}${LIVE_TABLE_SUFFIX}`);
const AUDIT_TABLE = q(`${COLLECTION_NAME}${AUDIT_TABLE_SUFFIX}`);
const TEN_SECONDS_MS = 10_000;

const config: MXDBCollectionConfig<TestRecord> = { name: COLLECTION_NAME, indexes: [] };

function makeRecord(overrides: Partial<TestRecord> = {}): TestRecord {
  return { id: 'r1', name: 'Alice', value: 1, ...overrides };
}

function createLoggerStub(): LoggerStub {
  const warn = vi.fn();
  const error = vi.fn();
  return { logger: { warn, error } as unknown as Logger, warn, error };
}

async function createCollection(logger?: Logger): Promise<CollectionFixture> {
  const worker = new SqliteWorkerClient();
  const ddl = buildTableDDL(COLLECTION_NAME, [], true);
  const collection = new DbCollection<TestRecord>(worker, worker.open(COLLECTION_NAME, ddl), config, logger);
  await collection.whenReady();
  return { collection, worker };
}

function captureEvents(collection: DbCollection<TestRecord>): MXDBCollectionEvent<TestRecord>[] {
  const events: MXDBCollectionEvent<TestRecord>[] = [];
  collection.onChange(event => events.push(event));
  return events;
}

/** Fire-and-forget persistence runs through async helpers; let their microtasks settle. */
async function drainMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}

function entryTypesOf(entries: { type: AuditEntryType }[] | undefined): AuditEntryType[] {
  return (entries ?? []).map(({ type }) => type);
}

/** A ULID strictly older / newer than anything the auditor generates "now". */
const olderUlid = (): string => ulid(Date.now() - TEN_SECONDS_MS);
const newerUlid = (): string => ulid(Date.now() + TEN_SECONDS_MS);

// ─── Reads ────────────────────────────────────────────────────────────────────

describe('DbCollection reads', () => {
  it('exposes the collection name from its config', async () => {
    const { collection } = await createCollection();

    expect(collection.name).toBe(COLLECTION_NAME);
  });

  it('returns the stored record when getting a single known id', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());

    expect(await collection.get('r1')).toEqual(makeRecord());
  });

  it('returns undefined when getting a single unknown id', async () => {
    const { collection } = await createCollection();

    expect(await collection.get('missing')).toBeUndefined();
  });

  it('returns only the known records, in request order, when getting many ids', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord({ id: 'a', name: 'A' }));
    await collection.upsert(makeRecord({ id: 'b', name: 'B' }));

    const records = await collection.get(['b', 'missing', 'a']);

    expect(records.map(({ id }) => id)).toEqual(['b', 'a']);
  });

  it('returns the audit for a single known id and undefined for an unknown one', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());

    const [known, unknown] = [await collection.getAudit('r1'), await collection.getAudit('missing')];

    expect([known?.id, unknown]).toEqual(['r1', undefined]);
  });

  it('returns only the known audits when getting many ids', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord({ id: 'a' }));

    const audits = await collection.getAudit(['a', 'missing']);

    expect(audits.map(({ id }) => id)).toEqual(['a']);
  });

  it('counts live records and reports whether an id exists', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord({ id: 'a' }));
    await collection.upsert(makeRecord({ id: 'b' }));

    const result = [await collection.count(), await collection.exists('a'), await collection.exists('zzz')];

    expect(result).toEqual([2, true, false]);
  });

  it('returns every tracked audit from getAllAudits', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord({ id: 'a' }));
    collection.applyServerWriteSync(makeRecord({ id: 'b' }), ulid());

    const ids = (await collection.getAllAudits()).map(({ id }) => id).sort();

    expect(ids).toEqual(['a', 'b']);
  });
});

// ─── Upsert ───────────────────────────────────────────────────────────────────

describe('DbCollection.upsert', () => {
  it('creates a Created audit entry and marks the record as pending for a new record', async () => {
    const { collection } = await createCollection();

    await collection.upsert(makeRecord());

    expect([entryTypesOf((await collection.getAudit('r1'))?.entries), await collection.hasPendingAudits()])
      .toEqual([[AuditEntryType.Created], true]);
  });

  it('appends an Updated audit entry when an existing record changes', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());

    await collection.upsert(makeRecord({ name: 'Alice 2' }));

    expect(entryTypesOf((await collection.getAudit('r1'))?.entries))
      .toEqual([AuditEntryType.Created, AuditEntryType.Updated]);
  });

  it('notifies subscribers with the upserted record and the default audit action', async () => {
    const { collection } = await createCollection();
    const events = captureEvents(collection);

    await collection.upsert(makeRecord());

    expect(events).toEqual([{ type: 'upsert', records: [makeRecord()], auditAction: 'default' }]);
  });

  it('does nothing when the record is deep-equal to the stored one', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());
    const events = captureEvents(collection);

    await collection.upsert(makeRecord());

    expect([events.length, entryTypesOf((await collection.getAudit('r1'))?.entries)])
      .toEqual([0, [AuditEntryType.Created]]);
  });

  it('creates a branch-only, non-pending audit anchored at the given ULID for a new branched record', async () => {
    const { collection } = await createCollection();
    const anchor = ulid();

    await collection.upsert(makeRecord(), 'branched', anchor);

    expect([(await collection.getAudit('r1'))?.entries, await collection.hasPendingAudits()])
      .toEqual([[{ type: AuditEntryType.Branched, id: anchor }], false]);
  });

  it('generates an anchor when a branched upsert is given no ULID', async () => {
    const { collection } = await createCollection();

    await collection.upsert(makeRecord(), 'branched');

    expect(entryTypesOf((await collection.getAudit('r1'))?.entries)).toEqual([AuditEntryType.Branched]);
  });

  it('preserves local entries newer than the anchor when branching an existing record', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());

    await collection.upsert(makeRecord({ name: 'Server' }), 'branched', olderUlid());

    expect([entryTypesOf((await collection.getAudit('r1'))?.entries), await collection.hasPendingAudits()])
      .toEqual([[AuditEntryType.Branched, AuditEntryType.Created], false]);
  });

  it('drops local entries older than the anchor when branching an existing record', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());
    await collection.upsert(makeRecord({ name: 'Local edit' }));

    await collection.upsert(makeRecord({ name: 'Server' }), 'branched', newerUlid());

    expect([entryTypesOf((await collection.getAudit('r1'))?.entries), await collection.hasPendingAudits()])
      .toEqual([[AuditEntryType.Branched], false]);
  });

  it('notifies subscribers of a branched upsert even when the record is unchanged', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());
    const events = captureEvents(collection);

    await collection.upsert(makeRecord(), 'branched', newerUlid());

    expect(events).toEqual([{ type: 'upsert', records: [makeRecord()], auditAction: 'branched' }]);
  });

  it('persists the record and its audit to SQLite', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());
    await collection.upsert(makeRecord({ name: 'Alice 2' }));
    const auditBefore = await collection.getAudit('r1');
    await drainMicrotasks();

    await collection.reloadFromWorker();

    expect([await collection.get('r1'), await collection.getAudit('r1')])
      .toEqual([makeRecord({ name: 'Alice 2' }), auditBefore]);
  });
});

// ─── Sync-state reads ─────────────────────────────────────────────────────────

describe('DbCollection sync-state reads', () => {
  it('returns active and deleted states for known ids and omits unknown ids from getStatesSync', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord({ id: 'live' }));
    await collection.upsert(makeRecord({ id: 'gone' }));
    await collection.delete('gone');

    const states = collection.getStatesSync(['live', 'gone', 'unknown']);

    expect(states.map(state => ('record' in state ? `active:${state.record.id}` : `deleted:${state.recordId}`)))
      .toEqual(['active:live', 'deleted:gone']);
  });

  it('returns only records with pending changes from getPendingStatesSync', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord({ id: 'local' }));
    await collection.upsert(makeRecord({ id: 'deleted-local' }));
    await collection.delete('deleted-local');
    collection.applyServerWriteSync(makeRecord({ id: 'server' }), ulid());

    const states = collection.getPendingStatesSync();

    expect(states.map(state => ('record' in state ? `active:${state.record.id}` : `deleted:${state.recordId}`)).sort())
      .toEqual(['active:local', 'deleted:deleted-local']);
  });

  it('returns every tracked record, pending or not, from getAllStatesSync', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord({ id: 'local' }));
    await collection.upsert(makeRecord({ id: 'deleted-local' }));
    await collection.delete('deleted-local');
    collection.applyServerWriteSync(makeRecord({ id: 'server' }), ulid());

    const states = collection.getAllStatesSync();

    expect(states.map(state => ('record' in state ? `active:${state.record.id}` : `deleted:${state.recordId}`)).sort())
      .toEqual(['active:local', 'active:server', 'deleted:deleted-local']);
  });
});

// ─── Server-sync appliers ─────────────────────────────────────────────────────

describe('DbCollection.applyServerWriteSync', () => {
  it('stores the record with a branch-only audit anchored at the given entry id', async () => {
    const { collection } = await createCollection();
    const anchor = ulid();

    collection.applyServerWriteSync(makeRecord(), anchor);

    expect([await collection.get('r1'), (await collection.getAudit('r1'))?.entries])
      .toEqual([makeRecord(), [{ type: AuditEntryType.Branched, id: anchor }]]);
  });

  it('generates an anchor when the last audit entry id is empty', async () => {
    const { collection } = await createCollection();

    collection.applyServerWriteSync(makeRecord(), '');

    const [entry] = (await collection.getAudit('r1'))?.entries ?? [];
    expect([entry?.type, entry?.id.length]).toEqual([AuditEntryType.Branched, 26]);
  });

  it('clears the pending state of a record that had local changes', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());

    collection.applyServerWriteSync(makeRecord({ name: 'Server' }), ulid());

    expect(await collection.hasPendingAudits()).toBe(false);
  });

  it('logs and skips the write when the database failed to open', async () => {
    const { logger, error } = createLoggerStub();
    const worker = new SqliteWorkerClient();
    const collection = new DbCollection<TestRecord>(worker, Promise.reject(new Error('open failed')), config, logger);

    collection.applyServerWriteSync(makeRecord(), ulid());
    await drainMicrotasks();

    expect(error).toHaveBeenCalledWith(
      `[DbCollection:${COLLECTION_NAME}] deferred server-sync write failed`,
      { error: expect.objectContaining({ message: 'open failed' }) },
    );
  });
});

describe('DbCollection.applyServerDeleteSync', () => {
  it('fully removes a record that has no pending changes and emits a remove event', async () => {
    const { collection } = await createCollection();
    collection.applyServerWriteSync(makeRecord(), ulid());
    const events = captureEvents(collection);

    collection.applyServerDeleteSync(['r1']);

    expect([await collection.get('r1'), await collection.getAudit('r1'), events])
      .toEqual([undefined, undefined, [{ type: 'remove', ids: ['r1'], auditAction: 'remove' }]]);
  });

  it('removes the live record but keeps the audit of a record with pending changes', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());
    const events = captureEvents(collection);

    collection.applyServerDeleteSync(['r1']);

    expect([await collection.get('r1'), (await collection.getAudit('r1'))?.id, events])
      .toEqual([undefined, 'r1', [{ type: 'remove', ids: ['r1'], auditAction: 'markAsDeleted' }]]);
  });

  it('emits separate events for fully removed and pending ids in the same call', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord({ id: 'pending' }));
    collection.applyServerWriteSync(makeRecord({ id: 'synced' }), ulid());
    const events = captureEvents(collection);

    collection.applyServerDeleteSync(['pending', 'synced']);

    expect(events).toEqual([
      { type: 'remove', ids: ['synced'], auditAction: 'remove' },
      { type: 'remove', ids: ['pending'], auditAction: 'markAsDeleted' },
    ]);
  });

  it.each([
    ['an empty id list', [] as string[]],
    ['ids the collection does not know', ['unknown']],
  ])('emits nothing for %s', async (_label, ids) => {
    const { collection } = await createCollection();
    const events = captureEvents(collection);

    collection.applyServerDeleteSync(ids);

    expect(events).toEqual([]);
  });

  it('persists the removal of both live row and audit to SQLite', async () => {
    const { collection } = await createCollection();
    collection.applyServerWriteSync(makeRecord(), ulid());
    collection.applyServerDeleteSync(['r1']);
    await drainMicrotasks();

    await collection.reloadFromWorker();

    expect([await collection.get('r1'), await collection.getAudit('r1')]).toEqual([undefined, undefined]);
  });
});

describe('DbCollection audit collapsing', () => {
  it('collapseAuditSync collapses the audit to the anchor, clearing pending state', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());
    const anchor = (await collection.getAudit('r1'))!.entries[0]!.id;

    collection.collapseAuditSync('r1', anchor);

    expect([(await collection.getAudit('r1'))?.entries, await collection.hasPendingAudits()])
      .toEqual([[{ type: AuditEntryType.Branched, id: anchor }], false]);
  });

  it('collapseAuditSync persists the collapsed audit to SQLite', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());
    const anchor = (await collection.getAudit('r1'))!.entries[0]!.id;
    collection.collapseAuditSync('r1', anchor);
    await drainMicrotasks();

    await collection.reloadFromWorker();

    expect((await collection.getAudit('r1'))?.entries).toEqual([{ type: AuditEntryType.Branched, id: anchor }]);
  });

  it('collapseAuditSync keeps entries after the anchor as pending', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());
    await collection.upsert(makeRecord({ name: 'Edited' }));
    const anchor = (await collection.getAudit('r1'))!.entries[0]!.id;

    collection.collapseAuditSync('r1', anchor);

    expect([entryTypesOf((await collection.getAudit('r1'))?.entries), await collection.hasPendingAudits()])
      .toEqual([[AuditEntryType.Branched, AuditEntryType.Updated], true]);
  });

  it('collapseAuditSync ignores an unknown record id', async () => {
    const { collection } = await createCollection();

    collection.collapseAuditSync('missing', ulid());

    expect(await collection.getAudit('missing')).toBeUndefined();
  });

  it('collapseAudit collapses the audit to the anchor, clearing pending state', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());
    const anchor = (await collection.getAudit('r1'))!.entries[0]!.id;

    await collection.collapseAudit('r1', anchor);

    expect([(await collection.getAudit('r1'))?.entries, await collection.hasPendingAudits()])
      .toEqual([[{ type: AuditEntryType.Branched, id: anchor }], false]);
  });

  it('collapseAudit ignores an unknown record id', async () => {
    const { collection } = await createCollection();

    await collection.collapseAudit('missing', ulid());

    expect(await collection.getAudit('missing')).toBeUndefined();
  });
});

// ─── Delete / audit removal ───────────────────────────────────────────────────

describe('DbCollection.delete', () => {
  const deleteTargets: [string, (records: TestRecord[]) => string | string[] | TestRecord | TestRecord[]][] = [
    ['a single id', records => records[0]!.id],
    ['an array of ids', records => records.map(({ id }) => id)],
    ['a single record', records => records[0]!],
    ['an array of records', records => records],
  ];

  it.each(deleteTargets)('removes the live record and appends a Deleted audit entry when given %s', async (_label, pick) => {
    const { collection } = await createCollection();
    const record = makeRecord();
    await collection.upsert(record);

    const result = await collection.delete(pick([record]) as string);

    expect([result, await collection.get('r1'), entryTypesOf((await collection.getAudit('r1'))?.entries)])
      .toEqual([true, undefined, [AuditEntryType.Created, AuditEntryType.Deleted]]);
  });

  it('returns false and changes nothing when given an empty array', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());

    const result = await collection.delete([] as string[]);

    expect([result, await collection.count()]).toEqual([false, 1]);
  });

  it('leaves the audit untouched when skipAuditAppend is set', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());

    await collection.delete('r1', { skipAuditAppend: true });

    expect([await collection.get('r1'), entryTypesOf((await collection.getAudit('r1'))?.entries)])
      .toEqual([undefined, [AuditEntryType.Created]]);
  });

  it('succeeds for an id with no live record or audit', async () => {
    const { collection } = await createCollection();

    expect(await collection.delete('unknown')).toBe(true);
  });

  it('persists the deletion and the Deleted audit entry to SQLite', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());
    await collection.delete('r1');
    const auditBefore = await collection.getAudit('r1');
    await drainMicrotasks();

    await collection.reloadFromWorker();

    expect([await collection.get('r1'), await collection.getAudit('r1')]).toEqual([undefined, auditBefore]);
  });
});

describe('DbCollection.removeAuditTrail', () => {
  it.each([
    ['a single id', 'r1' as string | string[]],
    ['an array of ids', ['r1']],
  ])('drops the audit and pending state when given %s', async (_label, ids) => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());

    await collection.removeAuditTrail(ids);

    expect([await collection.getAudit('r1'), await collection.hasPendingAudits()]).toEqual([undefined, false]);
  });

  it('persists the audit removal to SQLite', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());
    await collection.delete('r1', { skipAuditAppend: true });
    await collection.removeAuditTrail('r1');

    await collection.reloadFromWorker();

    expect(await collection.getAudit('r1')).toBeUndefined();
  });

  it('does nothing for an empty id list', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());

    await collection.removeAuditTrail([]);

    expect((await collection.getAudit('r1'))?.id).toBe('r1');
  });
});

describe('DbCollection.notifyRemove', () => {
  it('emits a remove event with the given ids and audit action', async () => {
    const { collection } = await createCollection();
    const events = captureEvents(collection);

    collection.notifyRemove(['a', 'b'], 'markAsDeleted');

    expect(events).toEqual([{ type: 'remove', ids: ['a', 'b'], auditAction: 'markAsDeleted' }]);
  });

  it('emits nothing for an empty id list', async () => {
    const { collection } = await createCollection();
    const events = captureEvents(collection);

    collection.notifyRemove([], 'remove');

    expect(events).toEqual([]);
  });
});

// ─── Query / distinct ─────────────────────────────────────────────────────────

describe('DbCollection.query and distinct', () => {
  const seed: TestRecord[] = [
    { id: 'a', name: 'Alice', value: 30 },
    { id: 'b', name: 'Bob', value: 10 },
    { id: 'c', name: 'Carol', value: 20 },
    { id: 'd', name: 'Bob', value: 40 },
  ];

  async function createSeededCollection(): Promise<DbCollection<TestRecord>> {
    const { collection } = await createCollection();
    collection.batchApplyServerWriteSync(seed.map(record => ({ record, lastAuditEntryId: ulid() })));
    await drainMicrotasks();
    return collection;
  }

  it('returns matching records and total for an in-memory-supported filter', async () => {
    const collection = await createSeededCollection();

    const { records, total } = await collection.query({ filters: { value: { $gte: 20 } }, sorts: [['value', 'asc']] });

    expect([records.map(({ id }) => id), total]).toEqual([['c', 'a', 'd'], 3]);
  });

  it('returns matching records and total for a filter that must be answered by SQLite', async () => {
    const collection = await createSeededCollection();

    const { records, total } = await collection.query({ filters: { name: { $ne: 'Bob' } }, sorts: [['value', 'desc']] });

    expect([records.map(({ id }) => id), total]).toEqual([['a', 'c'], 2]);
  });

  it('returns one page of records with the total count of all matches from SQLite', async () => {
    const collection = await createSeededCollection();

    const { records, total } = await collection.query({
      filters: { name: { $ne: 'Alice' } },
      sorts: [['value', 'asc']],
      pagination: { limit: 2, offset: 1 },
    });

    expect([records.map(({ id }) => id), total]).toEqual([['c', 'd'], 3]);
  });

  it('defaults the page offset to zero when paginating via SQLite', async () => {
    const collection = await createSeededCollection();

    const { records, total } = await collection.query({
      filters: { name: { $ne: 'Alice' } },
      sorts: [['value', 'asc']],
      pagination: { limit: 1 },
    });

    expect([records.map(({ id }) => id), total]).toEqual([['b'], 3]);
  });

  it('returns every record when the SQLite query has no filter or sort', async () => {
    const collection = await createSeededCollection();

    const { records, total } = await collection.query({ filters: { name: { $like: '%' } } });

    expect([records.map(({ id }) => id).sort(), total]).toEqual([['a', 'b', 'c', 'd'], 4]);
  });

  it('returns distinct values from memory for a supported filter', async () => {
    const collection = await createSeededCollection();

    const values = await collection.distinct({ field: 'name', sorts: [['name', 'asc']] });

    expect(values).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('returns distinct values from SQLite when sorted by another field', async () => {
    const collection = await createSeededCollection();

    const values = await collection.distinct({ field: 'name', filters: { value: { $ne: 40 } }, sorts: [['value', 'asc']] });

    expect(values).toEqual(['Bob', 'Carol', 'Alice']);
  });

  it('returns distinct values from SQLite with no filter or sort when the filter needs SQLite', async () => {
    const collection = await createSeededCollection();

    const values = await collection.distinct({ field: 'name', filters: { name: { $like: '%o%' } } });

    expect([...values].sort()).toEqual(['Bob', 'Carol']);
  });
});

// ─── Clear ────────────────────────────────────────────────────────────────────

describe('DbCollection.clear', () => {
  it('by default removes only records without pending changes and reports their ids', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord({ id: 'pending' }));
    collection.applyServerWriteSync(makeRecord({ id: 'synced' }), ulid());
    const events = captureEvents(collection);

    await collection.clear();

    expect([(await collection.getAll()).map(({ id }) => id), events])
      .toEqual([['pending'], [{ type: 'clear', ids: ['synced'] }]]);
  });

  it('by default persists the removal of synced records to SQLite', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord({ id: 'pending' }));
    collection.applyServerWriteSync(makeRecord({ id: 'synced' }), ulid());
    await collection.clear();
    await drainMicrotasks();

    await collection.reloadFromWorker();

    expect([(await collection.getAll()).map(({ id }) => id), await collection.getAudit('synced')])
      .toEqual([['pending'], undefined]);
  });

  it('with "all" removes every record and audit and reports the removed live ids', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord({ id: 'pending' }));
    collection.applyServerWriteSync(makeRecord({ id: 'synced' }), ulid());
    const events = captureEvents(collection);

    await collection.clear('all');

    expect([await collection.count(), await collection.getAllAudits(), await collection.hasPendingAudits(), events])
      .toEqual([0, [], false, [{ type: 'clear', ids: ['pending', 'synced'] }]]);
  });

  it('with "all" persists the wipe to SQLite', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());
    await collection.clear('all');
    await drainMicrotasks();

    await collection.reloadFromWorker();

    expect([await collection.count(), await collection.getAllAudits()]).toEqual([0, []]);
  });
});

// ─── Subscriptions ────────────────────────────────────────────────────────────

describe('DbCollection.onChange', () => {
  it('stops notifying a subscriber after it unsubscribes', async () => {
    const { collection } = await createCollection();
    const callback = vi.fn();
    const unsubscribe = collection.onChange(callback);
    unsubscribe();

    await collection.upsert(makeRecord());

    expect(callback).not.toHaveBeenCalled();
  });
});

// ─── Reload from SQLite ───────────────────────────────────────────────────────

describe('DbCollection.reloadFromWorker', () => {
  it('emits a reload event carrying the records read from SQLite', async () => {
    const { collection } = await createCollection();
    await collection.upsert(makeRecord());
    const events = captureEvents(collection);

    await collection.reloadFromWorker();

    expect(events).toEqual([{ type: 'reload', records: [makeRecord()] }]);
  });

  it('picks up rows written to SQLite by someone else (e.g. another tab)', async () => {
    const { collection, worker } = await createCollection();
    const createdId = ulid();
    await worker.execBatch([
      { sql: `INSERT INTO ${LIVE_TABLE}(id, data) VALUES (?, ?)`, params: ['ext', JSON.stringify({ id: 'ext', name: 'External' })] },
      {
        sql: `INSERT INTO ${AUDIT_TABLE}(id, recordId, type, timestamp, record, ops) VALUES (?, ?, ?, ?, ?, ?)`,
        params: [createdId, 'ext', AuditEntryType.Created, 0, JSON.stringify({ id: 'ext', name: 'External' }), null],
      },
    ]);

    await collection.reloadFromWorker();

    expect([await collection.get('ext'), await collection.hasPendingAudits()])
      .toEqual([{ id: 'ext', name: 'External' }, true]);
  });

  it('decodes every stored audit entry shape, including null payloads', async () => {
    const { collection, worker } = await createCollection();
    const [createdId, updatedId, deletedId, restoredBareId, restoredWithRecordId] = [ulid(0), ulid(1), ulid(2), ulid(3), ulid(4)];
    const insertAudit = (id: string, type: AuditEntryType, record: string | null, ops: string | null) => ({
      sql: `INSERT INTO ${AUDIT_TABLE}(id, recordId, type, timestamp, record, ops) VALUES (?, ?, ?, ?, ?, ?)`,
      params: [id, 'x', type, 0, record, ops],
    });
    await worker.execBatch([
      insertAudit(createdId, AuditEntryType.Created, null, null),
      insertAudit(updatedId, AuditEntryType.Updated, null, null),
      insertAudit(deletedId, AuditEntryType.Deleted, null, null),
      insertAudit(restoredBareId, AuditEntryType.Restored, null, null),
      insertAudit(restoredWithRecordId, AuditEntryType.Restored, JSON.stringify({ id: 'x', name: 'Back' }), null),
    ]);

    await collection.reloadFromWorker();

    expect((await collection.getAudit('x'))?.entries).toEqual([
      { id: createdId, type: AuditEntryType.Created, record: null },
      { id: updatedId, type: AuditEntryType.Updated, ops: [] },
      { id: deletedId, type: AuditEntryType.Deleted },
      { id: restoredBareId, type: AuditEntryType.Restored },
      { id: restoredWithRecordId, type: AuditEntryType.Restored, record: { id: 'x', name: 'Back' } },
    ]);
  });

  it('drops live rows that have no audit trail from memory and from SQLite, logging a warning', async () => {
    const { logger, warn } = createLoggerStub();
    const { collection, worker } = await createCollection(logger);
    await worker.exec(`INSERT INTO ${LIVE_TABLE}(id, data) VALUES (?, ?)`, ['orphan', JSON.stringify({ id: 'orphan', name: 'Ghost' })]);

    await collection.reloadFromWorker();

    const remainingRows = await worker.query(`SELECT id FROM ${LIVE_TABLE}`);
    expect([await collection.get('orphan'), remainingRows, warn.mock.calls[0]?.[1]])
      .toEqual([undefined, [], { orphanIds: ['orphan'] }]);
  });
});
