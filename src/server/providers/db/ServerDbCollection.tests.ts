import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Logger, Record } from '@anupheaus/common';
import { defineCollection } from '../../../common/defineCollection';
import { ServerDbCollection } from './ServerDbCollection';

// ────────────────────────────────────────────────────────────────────────────
// Test record type
// ────────────────────────────────────────────────────────────────────────────

interface TestItem extends Record {
  name: string;
  value?: number;
  category?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Collection definition (registered once in the module-level config registry)
// ────────────────────────────────────────────────────────────────────────────

const testCollection = defineCollection<TestItem>({ name: 'test_items', indexes: [], disableAudit: true });

// A second collection used by tests that need an isolated namespace
const altCollection = defineCollection<TestItem>({ name: 'test_items_alt', indexes: [], disableAudit: true });

// ────────────────────────────────────────────────────────────────────────────
// Mock logger — captures calls so tests can assert on warn/error if needed
// ────────────────────────────────────────────────────────────────────────────

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  silly: vi.fn(),
  createSubLogger: vi.fn().mockReturnThis(),
} as unknown as Logger;

// ────────────────────────────────────────────────────────────────────────────
// Mongo in-process replica set (supports transactions + change streams)
// ────────────────────────────────────────────────────────────────────────────

let mongod: MongoMemoryReplSet;
let client: MongoClient;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(mongod.getUri());
  await client.connect();
}, 90_000);

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

// ────────────────────────────────────────────────────────────────────────────
// Per-test cleanup: drop and re-create collections so each test starts fresh.
// We re-create them immediately so that #configure()'s createCollection call
// finds an existing collection rather than racing to create it concurrently.
// ────────────────────────────────────────────────────────────────────────────

// Track collection names that have been configured at least once during this run.
// Passing this pre-populated set to new ServerDbCollection instances prevents
// #getCollectionByName from calling db.createCollection on an already-existing
// collection (which would fail with NamespaceExists when #configure runs async).
const knownCollectionNames = new Set<string>();

beforeEach(async () => {
  const db = client.db('testdb');
  // Drop all data, but preserve the collection namespaces so #configure's
  // async createCollection calls don't race against each other.
  await db.collection(testCollection.name).deleteMany({});
  await db.collection(altCollection.name).deleteMany({});
});

// ────────────────────────────────────────────────────────────────────────────
// Helper: construct a ServerDbCollection wired to the in-process replica set
// ────────────────────────────────────────────────────────────────────────────

// Shared promise for the initial setup: creates collections once so that
// subsequent makeCol() calls see them in knownCollectionNames and skip
// db.createCollection(), preventing NamespaceExists errors from #configure().
let setupPromise: Promise<void> | undefined;

function ensureCollectionsSetup(): Promise<void> {
  if (setupPromise != null) return setupPromise;
  setupPromise = (async () => {
    const db = client.db('testdb');
    for (const name of [testCollection.name, altCollection.name]) {
      try {
        await db.createCollection(name);
      } catch {
        // Already exists — that's fine
      }
      knownCollectionNames.add(name);
    }
  })();
  return setupPromise;
}

async function makeCol(coll = testCollection) {
  await ensureCollectionsSetup();
  const db = client.db('testdb');
  // Provide the pre-populated set so #getCollectionByName uses db.collection()
  // (not db.createCollection()) on subsequent ServerDbCollection instantiations.
  return new ServerDbCollection<TestItem>({
    getDb: () => Promise.resolve(db),
    collection: coll,
    collectionNames: Promise.resolve(new Set(knownCollectionNames)),
    logger: mockLogger,
  });
}

// Convenience: build a minimal TestItem from partial data
function makeItem(overrides: Partial<TestItem> & { id: string; name: string }): TestItem {
  return { value: 0, ...overrides };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('ServerDbCollection', () => {
  // ── get ──────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns undefined for a non-existent id', async () => {
      const col = await makeCol();
      const result = await col.get('missing-id');
      expect(result).toBeUndefined();
    });

    it('returns the record after upsert (single id)', async () => {
      const col = await makeCol();
      const item = makeItem({ id: 'item-1', name: 'Alpha' });
      await col.upsert(item);
      const result = await col.get('item-1');
      expect(result).toMatchObject({ id: 'item-1', name: 'Alpha' });
    });

    it('returns an array when called with an array of ids', async () => {
      const col = await makeCol();
      await col.upsert([
        makeItem({ id: 'a', name: 'A' }),
        makeItem({ id: 'b', name: 'B' }),
      ]);
      const results = await col.get(['a', 'b']);
      expect(results).toHaveLength(2);
      expect(results.map(r => r.id).sort()).toEqual(['a', 'b']);
    });

    it('returns only found records when some ids are missing', async () => {
      const col = await makeCol();
      await col.upsert(makeItem({ id: 'exists', name: 'Exists' }));
      const results = await col.get(['exists', 'does-not-exist']);
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('exists');
    });
  });

  // ── upsert ───────────────────────────────────────────────────────────────

  describe('upsert', () => {
    it('inserts a new record', async () => {
      const col = await makeCol();
      const item = makeItem({ id: 'new-1', name: 'New' });
      await col.upsert(item);
      expect(await col.get('new-1')).toMatchObject({ id: 'new-1', name: 'New' });
    });

    it('updates an existing record', async () => {
      const col = await makeCol();
      const item = makeItem({ id: 'upd-1', name: 'Original' });
      await col.upsert(item);
      await col.upsert({ ...item, name: 'Updated' });
      const result = await col.get('upd-1');
      expect(result?.name).toBe('Updated');
    });

    it('is a no-op for an empty array', async () => {
      const col = await makeCol();
      // Should not throw and nothing inserted
      await col.upsert([]);
      expect(await col.count()).toBe(0);
    });

    it('skips records that are deeply equal to existing', async () => {
      const col = await makeCol();
      const item = makeItem({ id: 'dup-1', name: 'Same' });
      await col.upsert(item);
      // Upserting the same record should leave the collection unchanged
      await col.upsert({ ...item });
      expect(await col.count()).toBe(1);
    });
  });

  // ── remove ───────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('removes a record by single id', async () => {
      const col = await makeCol();
      await col.upsert(makeItem({ id: 'del-1', name: 'Delete Me' }));
      await col.remove('del-1');
      expect(await col.get('del-1')).toBeUndefined();
    });

    it('removes records by array of ids', async () => {
      const col = await makeCol();
      await col.upsert([
        makeItem({ id: 'del-2', name: 'D2' }),
        makeItem({ id: 'del-3', name: 'D3' }),
      ]);
      await col.remove(['del-2', 'del-3']);
      expect(await col.get(['del-2', 'del-3'])).toHaveLength(0);
    });

    it('is a no-op for a non-existent id', async () => {
      const col = await makeCol();
      // Should not throw
      await expect(col.remove('ghost')).resolves.toBeUndefined();
    });
  });

  // ── query ─────────────────────────────────────────────────────────────────

  describe('query', () => {
    it('returns all records with no request argument', async () => {
      const col = await makeCol();
      await col.upsert([
        makeItem({ id: 'q1', name: 'Q1' }),
        makeItem({ id: 'q2', name: 'Q2' }),
      ]);
      const { data, total } = await col.query();
      expect(total).toBe(2);
      expect(data).toHaveLength(2);
    });

    it('returns empty data when the collection is empty', async () => {
      const col = await makeCol();
      const { data, total } = await col.query();
      expect(data).toHaveLength(0);
      expect(total).toBe(0);
    });

    it('applies pagination limit', async () => {
      const col = await makeCol();
      await col.upsert([
        makeItem({ id: 'p1', name: 'P1' }),
        makeItem({ id: 'p2', name: 'P2' }),
        makeItem({ id: 'p3', name: 'P3' }),
      ]);
      const { data } = await col.query({ pagination: { limit: 2 } });
      expect(data).toHaveLength(2);
    });

    it('applies pagination offset', async () => {
      const col = await makeCol();
      await col.upsert([
        makeItem({ id: 'o1', name: 'O1' }),
        makeItem({ id: 'o2', name: 'O2' }),
        makeItem({ id: 'o3', name: 'O3' }),
      ]);
      const { data } = await col.query({ pagination: { offset: 2, limit: 10 } });
      expect(data).toHaveLength(1);
    });

    it('filters by field value', async () => {
      const col = await makeCol();
      await col.upsert([
        makeItem({ id: 'f1', name: 'Foo', category: 'x' }),
        makeItem({ id: 'f2', name: 'Bar', category: 'y' }),
      ]);
      const { data } = await col.query({ filters: { category: 'x' } as any });
      expect(data).toHaveLength(1);
      expect(data[0]!.id).toBe('f1');
    });
  });

  // ── getAll ────────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns all records', async () => {
      const col = await makeCol();
      await col.upsert([
        makeItem({ id: 'ga1', name: 'GA1' }),
        makeItem({ id: 'ga2', name: 'GA2' }),
      ]);
      const results = await col.getAll();
      expect(results).toHaveLength(2);
    });

    it('returns an empty array when no records exist', async () => {
      const col = await makeCol(altCollection);
      const results = await col.getAll();
      expect(results).toEqual([]);
    });
  });

  // ── find ──────────────────────────────────────────────────────────────────

  describe('find', () => {
    it('returns the first matching record', async () => {
      const col = await makeCol();
      await col.upsert(makeItem({ id: 'fi1', name: 'FindMe', category: 'match' }));
      const result = await col.find({ category: 'match' } as any);
      expect(result).toBeDefined();
      expect(result?.id).toBe('fi1');
    });

    it('returns undefined when no record matches', async () => {
      const col = await makeCol();
      const result = await col.find({ category: 'no-such-category' } as any);
      expect(result).toBeUndefined();
    });
  });

  // ── distinct ──────────────────────────────────────────────────────────────

  describe('distinct', () => {
    it('returns distinct records grouped by field', async () => {
      const col = await makeCol();
      await col.upsert([
        makeItem({ id: 'di1', name: 'Item1', category: 'cat-a' }),
        makeItem({ id: 'di2', name: 'Item2', category: 'cat-a' }),
        makeItem({ id: 'di3', name: 'Item3', category: 'cat-b' }),
      ]);
      // distinct by category returns one record per unique category value
      const results = await col.distinct({ field: 'category' });
      expect(results).toHaveLength(2);
      const categories = results.map(r => r.category).sort();
      expect(categories).toEqual(['cat-a', 'cat-b']);
    });
  });

  // ── count ─────────────────────────────────────────────────────────────────

  describe('count', () => {
    it('returns 0 for an empty collection', async () => {
      const col = await makeCol();
      expect(await col.count()).toBe(0);
    });

    it('returns the correct count after upsert', async () => {
      const col = await makeCol();
      await col.upsert([
        makeItem({ id: 'c1', name: 'C1' }),
        makeItem({ id: 'c2', name: 'C2' }),
        makeItem({ id: 'c3', name: 'C3' }),
      ]);
      expect(await col.count()).toBe(3);
    });
  });

  // ── clear ─────────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('removes all records', async () => {
      const col = await makeCol();
      await col.upsert([
        makeItem({ id: 'cl1', name: 'CL1' }),
        makeItem({ id: 'cl2', name: 'CL2' }),
      ]);
      await col.clear();
      expect(await col.count()).toBe(0);
    });
  });

  // ── sync ──────────────────────────────────────────────────────────────────

  describe('sync', () => {
    it('writes updated records and returns a success result per id', async () => {
      const col = await makeCol();
      const item = makeItem({ id: 'sync-1', name: 'SyncItem' });
      const results = await col.sync({ updated: [item], updatedAudits: [], removedIds: [] });
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ id: 'sync-1' });
      const stored = await col.get('sync-1');
      expect(stored).toMatchObject({ id: 'sync-1', name: 'SyncItem' });
    });

    it('deletes records listed in removedIds', async () => {
      const col = await makeCol();
      await col.upsert(makeItem({ id: 'sync-del-1', name: 'ToDelete' }));
      const results = await col.sync({ updated: [], updatedAudits: [], removedIds: ['sync-del-1'] });
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ id: 'sync-del-1' });
      expect(await col.get('sync-del-1')).toBeUndefined();
    });
  });
});
