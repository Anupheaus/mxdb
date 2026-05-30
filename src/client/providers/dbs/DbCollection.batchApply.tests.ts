import { describe, it, expect, beforeEach } from 'vitest';
import type { Record } from '@anupheaus/common';
import { ulid } from 'ulidx';
import { SqliteWorkerClient } from '../../db-worker/SqliteWorkerClient';
import { buildTableDDL } from '../../db-worker/buildTableDDL';
import { DbCollection } from './DbCollection';
import type { MXDBCollectionConfig } from '../../../common/models';
import type { MXDBCollectionEvent } from './models';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestRecord extends Record {
  id: string;
  name: string;
  value?: number;
}

const collectionConfig: MXDBCollectionConfig<TestRecord> = {
  name: 'test-records',
  indexes: [],
};

/** Spin up an in-process SQLite worker client (InlineRunner path — no Worker needed). */
async function createCollection(): Promise<{
  collection: DbCollection<TestRecord>;
  worker: SqliteWorkerClient;
}> {
  const worker = new SqliteWorkerClient();
  const ddl = buildTableDDL(collectionConfig.name, collectionConfig.indexes ?? [], true);
  const openReady = worker.open(collectionConfig.name, ddl);
  const collection = new DbCollection<TestRecord>(worker, openReady, collectionConfig);
  await collection.whenReady();
  return { collection, worker };
}

function makeRecord(id: string, name: string, value?: number): TestRecord {
  return { id, name, value };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DbCollection > batchApplyServerWriteSync', () => {

  let collection: DbCollection<TestRecord>;

  beforeEach(async () => {
    ({ collection } = await createCollection());
  });

  // ── Basic correctness ────────────────────────────────────────────────────

  it('applies all records to the in-memory store', async () => {
    const items = [
      { record: makeRecord('r1', 'Alice'), lastAuditEntryId: ulid() },
      { record: makeRecord('r2', 'Bob'), lastAuditEntryId: ulid() },
      { record: makeRecord('r3', 'Carol'), lastAuditEntryId: ulid() },
    ];

    collection.batchApplyServerWriteSync(items);

    const all = await collection.getAll();
    expect(all).toHaveLength(3);
    const ids = all.map(r => r.id).sort();
    expect(ids).toEqual(['r1', 'r2', 'r3']);
  });

  it('fires onChange exactly once for multiple records', () => {
    const events: MXDBCollectionEvent<TestRecord>[] = [];
    collection.onChange(event => events.push(event));

    const items = [
      { record: makeRecord('r1', 'Alice'), lastAuditEntryId: ulid() },
      { record: makeRecord('r2', 'Bob'), lastAuditEntryId: ulid() },
      { record: makeRecord('r3', 'Carol'), lastAuditEntryId: ulid() },
    ];

    collection.batchApplyServerWriteSync(items);

    expect(events).toHaveLength(1);
  });

  it('includes all records in the single onChange event', () => {
    const events: MXDBCollectionEvent<TestRecord>[] = [];
    collection.onChange(event => events.push(event));

    const items = [
      { record: makeRecord('r1', 'Alice'), lastAuditEntryId: ulid() },
      { record: makeRecord('r2', 'Bob'), lastAuditEntryId: ulid() },
    ];

    collection.batchApplyServerWriteSync(items);

    expect(events[0]?.type).toBe('upsert');
    const upsertEvent = events[0] as Extract<MXDBCollectionEvent<TestRecord>, { type: 'upsert' }>;
    expect(upsertEvent.records).toHaveLength(2);
    expect(upsertEvent.records.map(r => r.id).sort()).toEqual(['r1', 'r2']);
  });

  it('reports auditAction as "branched" in the onChange event', () => {
    const events: MXDBCollectionEvent<TestRecord>[] = [];
    collection.onChange(event => events.push(event));

    collection.batchApplyServerWriteSync([
      { record: makeRecord('r1', 'Alice'), lastAuditEntryId: ulid() },
    ]);

    const event = events[0] as Extract<MXDBCollectionEvent<TestRecord>, { type: 'upsert' }>;
    expect(event.auditAction).toBe('branched');
  });

  it('does nothing when given an empty array', () => {
    const events: MXDBCollectionEvent<TestRecord>[] = [];
    collection.onChange(event => events.push(event));

    collection.batchApplyServerWriteSync([]);

    expect(events).toHaveLength(0);
  });

  it('overwrites existing in-memory records', async () => {
    // Seed with a record
    collection.batchApplyServerWriteSync([
      { record: makeRecord('r1', 'Alice', 1), lastAuditEntryId: ulid() },
    ]);

    // Overwrite with new value
    collection.batchApplyServerWriteSync([
      { record: makeRecord('r1', 'Alice Updated', 42), lastAuditEntryId: ulid() },
    ]);

    const all = await collection.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe('Alice Updated');
    expect(all[0]?.value).toBe(42);
  });

  it('produces one onChange per call — not one per record — compared with applyServerWriteSync', () => {
    const batchEvents: MXDBCollectionEvent<TestRecord>[] = [];
    collection.onChange(event => batchEvents.push(event));

    const items = [
      { record: makeRecord('b1', 'One'), lastAuditEntryId: ulid() },
      { record: makeRecord('b2', 'Two'), lastAuditEntryId: ulid() },
      { record: makeRecord('b3', 'Three'), lastAuditEntryId: ulid() },
    ];

    // batchApplyServerWriteSync: one onChange for all three records
    collection.batchApplyServerWriteSync(items);
    expect(batchEvents).toHaveLength(1);
    const upsertEvent = batchEvents[0] as Extract<MXDBCollectionEvent<TestRecord>, { type: 'upsert' }>;
    expect(upsertEvent.records).toHaveLength(3);
  });

  it('marks records as non-pending (branched audit has no pending changes)', async () => {
    collection.batchApplyServerWriteSync([
      { record: makeRecord('r1', 'Alice'), lastAuditEntryId: ulid() },
      { record: makeRecord('r2', 'Bob'), lastAuditEntryId: ulid() },
    ]);

    // No pending audits — server-written records are fully synced
    const hasPending = await collection.hasPendingAudits();
    expect(hasPending).toBe(false);
  });

  it('persists records to SQLite (readable after reload from worker)', async () => {
    collection.batchApplyServerWriteSync([
      { record: makeRecord('p1', 'Persisted'), lastAuditEntryId: ulid() },
    ]);

    // Allow the fire-and-forget persist to complete
    await new Promise(r => setTimeout(r, 50));

    await collection.reloadFromWorker();
    const all = await collection.getAll();
    expect(all.some(r => r.id === 'p1')).toBe(true);
  });

  // ── Comparison against individual applyServerWriteSync ───────────────────

  it('fires N onChange events when N records applied individually (demonstrating the problem the batch fixes)', async () => {
    const { collection: singleCollection } = await createCollection();
    const singleEvents: MXDBCollectionEvent<TestRecord>[] = [];
    singleCollection.onChange(event => singleEvents.push(event));

    const records = [
      makeRecord('s1', 'One'),
      makeRecord('s2', 'Two'),
      makeRecord('s3', 'Three'),
    ];

    for (const record of records) {
      singleCollection.applyServerWriteSync(record, ulid());
    }

    // Each individual call fires a separate onChange — 3 events for 3 records
    expect(singleEvents).toHaveLength(3);
  });

});
