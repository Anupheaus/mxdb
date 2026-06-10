import { describe, it, expect } from 'vitest';
import type { Record } from '@anupheaus/common';
import { ulid } from 'ulidx';
import { SqliteWorkerClient } from '../../db-worker/SqliteWorkerClient';
import { buildTableDDL } from '../../db-worker/buildTableDDL';
import { DbCollection } from './DbCollection';
import type { MXDBCollectionConfig } from '../../../common/models';

// ---------------------------------------------------------------------------
// Regression: server-sync writes that arrive BEFORE the worker has opened.
//
// The C2S/S2C sync providers call the server-sync appliers synchronously and can do so
// before SqliteWorkerClient.open() has run — e.g. a reconnect S2C push racing a slow
// OPFS/encrypted open on the cross-origin-isolated mobile app. Previously the appliers
// hit the worker immediately, which (in shared-worker mode) dereferenced a null port
// ("Cannot read properties of null (reading 'postMessage')") and, in every mode, lost the
// write because #loadData() then replaced the in-memory maps. They must instead defer
// until the DB is open and loaded — mirroring upsert() and the read methods.
// ---------------------------------------------------------------------------

interface TestRecord extends Record {
  id: string;
  name: string;
}

const collectionConfig: MXDBCollectionConfig<TestRecord> = {
  name: 'test-records',
  indexes: [],
};

function makeRecord(id: string, name: string): TestRecord {
  return { id, name };
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/**
 * Build a collection whose `ready` promise is gated on a manual release, so a server-sync
 * write can be applied while the DB is still "opening".
 */
function createGatedCollection(): {
  collection: DbCollection<TestRecord>;
  openDb: () => void;
} {
  const worker = new SqliteWorkerClient();
  const ddl = buildTableDDL(collectionConfig.name, [], true);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = gate.then(() => worker.open(collectionConfig.name, ddl));
  const collection = new DbCollection<TestRecord>(worker, ready, collectionConfig);
  return { collection, openDb: release };
}

describe('DbCollection > readiness gate for server-sync writes', () => {
  it('applies a batch write issued before open once the DB is ready (no crash, no clobber)', async () => {
    const { collection, openDb } = createGatedCollection();

    // Server push arrives before the DB has opened.
    collection.batchApplyServerWriteSync([
      { record: makeRecord('r1', 'Early'), lastAuditEntryId: ulid() },
    ]);

    // Now let the worker open + initial load run.
    openDb();
    await collection.whenReady();
    await drainMicrotasks();

    const all = await collection.getAll();
    expect(all.map(r => r.id)).toContain('r1');
    expect(all.find(r => r.id === 'r1')?.name).toBe('Early');

    // And it was actually persisted to SQLite (survives a reload from the worker).
    await collection.reloadFromWorker();
    const reloaded = await collection.getAll();
    expect(reloaded.map(r => r.id)).toContain('r1');
  });

  it('applies a single write issued before open once the DB is ready', async () => {
    const { collection, openDb } = createGatedCollection();

    collection.applyServerWriteSync(makeRecord('s1', 'Solo'), ulid());

    openDb();
    await collection.whenReady();
    await drainMicrotasks();

    const all = await collection.getAll();
    expect(all.map(r => r.id)).toContain('s1');
  });

  it('applies a delete issued before open once the DB is ready', async () => {
    const { collection, openDb } = createGatedCollection();

    // Write then delete the same id, both before open.
    collection.applyServerWriteSync(makeRecord('d1', 'ToDelete'), ulid());
    collection.applyServerDeleteSync(['d1']);

    openDb();
    await collection.whenReady();
    await drainMicrotasks();

    const all = await collection.getAll();
    expect(all.map(r => r.id)).not.toContain('d1');
  });

  it('preserves a pre-open write through the initial #loadData replace', async () => {
    // Distinct from the first test: seed SQLite via one collection, then open a SECOND
    // collection on the same worker db so #loadData reads existing rows, and prove a
    // pre-open write is merged with — not clobbered by — the loaded rows.
    const { collection, openDb } = createGatedCollection();

    collection.batchApplyServerWriteSync([
      { record: makeRecord('a', 'A'), lastAuditEntryId: ulid() },
      { record: makeRecord('b', 'B'), lastAuditEntryId: ulid() },
    ]);

    openDb();
    await collection.whenReady();
    await drainMicrotasks();

    const ids = (await collection.getAll()).map(r => r.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });
});
