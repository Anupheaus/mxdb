import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Logger, Record } from '@anupheaus/common';
import { defineCollection } from '../../../common/defineCollection';
import { ServerDbCollection } from './ServerDbCollection';
import { hashRecord } from '../../../common/auditor/hash';
import { auditor } from '../../../common/auditor';
import { AuditEntryType } from '../../../common/auditor/auditor-models';
import { DateTime } from 'luxon';

// The acting user comes from the nexus socket/auth context (external); stub it so audit
// attribution can be exercised both with and without an authenticated user.
const mockAuthenticatedUser = vi.fn<() => { id: string } | undefined>(() => undefined);
vi.mock('@anupheaus/nexus/server', async importOriginal => {
  const actual = await importOriginal() as object;
  return { ...actual, useAuthentication: () => ({ user: mockAuthenticatedUser() }) };
});

// ────────────────────────────────────────────────────────────────────────────
// Test record type
// ────────────────────────────────────────────────────────────────────────────

interface TestItem extends Record {
  name: string;
  value?: number;
  category?: string;
  createdAt?: DateTime;
}

// ────────────────────────────────────────────────────────────────────────────
// Collection definition (registered once in the module-level config registry)
// ────────────────────────────────────────────────────────────────────────────

const testCollection = defineCollection<TestItem>({ name: 'test_items', indexes: [], disableAudit: true });

// A second collection used by tests that need an isolated namespace
const altCollection = defineCollection<TestItem>({ name: 'test_items_alt', indexes: [], disableAudit: true });

// An audited collection (the default) — writes also maintain `<name>_sync` audit documents.
const auditedCollection = defineCollection<TestItem>({ name: 'test_items_audited', indexes: [] });
const AUDIT_COLLECTION_NAME = `${auditedCollection.name}_sync`;

// A collection whose declared indexes are reconciled against the ones already in Mongo.
const indexedCollection = defineCollection<TestItem>({
  name: 'test_items_indexed',
  indexes: [
    { name: 'by_name', fields: ['name'], isUnique: true },
    { name: 'by_category', fields: ['category'], isSparse: true },
  ],
  disableAudit: true,
});

/** Audit writes on upsert/remove are fire-and-forget, so poll (condition-based, no fixed sleep) until they land. */
const AUDIT_WAIT = { timeout: 10_000, interval: 20 };

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
  await db.collection(auditedCollection.name).deleteMany({});
  await db.collection(AUDIT_COLLECTION_NAME).deleteMany({});
  mockAuthenticatedUser.mockReturnValue(undefined);
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
    for (const name of [testCollection.name, altCollection.name, auditedCollection.name, AUDIT_COLLECTION_NAME]) {
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

async function makeCol(coll: typeof testCollection = testCollection) {
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

  // ── _meta (stored record hash, for cheap C2S comparison) ──────────────────

  describe('_meta', () => {
    it('stores _meta.hash equal to hashRecord of the read-back record', async () => {
      const col = await makeCol();
      await col.upsert(makeItem({ id: 'meta-1', name: 'Meta' }));
      const raw = await client.db('testdb').collection(testCollection.name).findOne({ _id: 'meta-1' as any });
      const readBack = await col.get('meta-1');
      expect(raw?._meta?.hash).toBe(await hashRecord(readBack!));
    });

    it('stores _meta.hash when written via sync', async () => {
      const col = await makeCol();
      await col.sync({ updated: [makeItem({ id: 'sync-meta-1', name: 'SyncMeta' })], updatedAudits: [], removedIds: [] });
      const raw = await client.db('testdb').collection(testCollection.name).findOne({ _id: 'sync-meta-1' as any });
      const readBack = await col.get('sync-meta-1');
      expect(raw?._meta?.hash).toBe(await hashRecord(readBack!));
    });

    it('stores _meta.lastAuditEntryId from the audit on sync', async () => {
      const col = await makeCol();
      const item = makeItem({ id: 'la-1', name: 'LA' });
      const audit = auditor.createAuditFrom(item);
      await col.sync({ updated: [item], updatedAudits: [audit], removedIds: [] });
      const raw = await client.db('testdb').collection(testCollection.name).findOne({ _id: 'la-1' as any });
      expect(raw?._meta?.lastAuditEntryId).toBe(auditor.getLastEntryId(audit));
    });

    it('getMeta returns the stored hash per id without the full record', async () => {
      const col = await makeCol();
      await col.upsert([makeItem({ id: 'gm-1', name: 'A' }), makeItem({ id: 'gm-2', name: 'B' })]);
      const metas = await col.getMeta(['gm-1', 'gm-2', 'gm-missing']);
      const byId = new Map(metas.map(m => [m.id, m]));
      expect(byId.get('gm-1')?.hash).toBe(await hashRecord((await col.get('gm-1'))!));
      expect(byId.has('gm-missing')).toBe(false);
      expect((byId.get('gm-1') as { name?: string }).name).toBeUndefined(); // projection only — no record fields
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

  // ── identity ──────────────────────────────────────────────────────────────

  it('exposes the collection it was created for and its name', async () => {
    const col = await makeCol();
    expect({ name: col.name, collection: col.collection }).toEqual({ name: testCollection.name, collection: testCollection });
  });

  // ── getMeta edge cases ────────────────────────────────────────────────────

  describe('getMeta edge cases', () => {
    it('returns an empty list when asked for no ids', async () => {
      const col = await makeCol();
      expect(await col.getMeta([])).toEqual([]);
    });

    it('omits documents that were stored without a hash', async () => {
      const col = await makeCol();
      await client.db('testdb').collection(testCollection.name).insertOne({ _id: 'legacy-1' as any, name: 'Legacy' });
      expect(await col.getMeta(['legacy-1'])).toEqual([]);
    });
  });

  // ── query: sorting, totals, filter translation ────────────────────────────

  describe('query options', () => {
    const seed = async () => {
      const col = await makeCol();
      await col.upsert([
        makeItem({ id: 'b', name: 'Bravo', category: 'x' }),
        makeItem({ id: 'c', name: 'Charlie', category: 'y' }),
        makeItem({ id: 'a', name: 'Alpha', category: 'x' }),
      ]);
      return col;
    };

    it('reports the total number of matching records when an accurate total is requested', async () => {
      const col = await seed();
      const { data, total } = await col.query({ pagination: { limit: 1 }, getAccurateTotal: true });
      expect({ returned: data.length, total }).toEqual({ returned: 1, total: 3 });
    });

    it('reports only the returned count as the total when an accurate total is not requested', async () => {
      const col = await seed();
      const { total } = await col.query({ pagination: { limit: 1 } });
      expect(total).toBe(1);
    });

    it.each([
      ['an empty request', {}],
      ['empty filters', { filters: {} }],
      ['server hints with only undefined values', { serverHints: { scope: undefined } }],
      ['server hints with a value', { serverHints: { scope: 'all' } }],
    ])('returns every record for %s', async (_label, request) => {
      const col = await seed();
      const { data } = await col.query(request as any);
      expect(data.ids().sort()).toEqual(['a', 'b', 'c']);
    });

    it('filters on id', async () => {
      const col = await seed();
      const { data } = await col.query({ filters: { id: 'b' } as any });
      expect(data.ids()).toEqual(['b']);
    });

    it('filters on date ranges expressed as Luxon DateTimes', async () => {
      const col = await makeCol();
      const base = DateTime.fromISO('2024-01-10T00:00:00.000Z');
      await col.upsert([
        makeItem({ id: 'old', name: 'Old', createdAt: base.minus({ days: 5 }) }),
        makeItem({ id: 'new', name: 'New', createdAt: base.plus({ days: 5 }) }),
      ]);
      const { data } = await col.query({ filters: { createdAt: { $gt: base } } as any });
      expect(data.ids()).toEqual(['new']);
    });

    it('find translates id filters', async () => {
      const col = await seed();
      const result = await col.find({ id: 'c' } as any);
      expect(result?.name).toBe('Charlie');
    });

    // ── sorting ──

    it.each([
      ['name descending', [['name', 'desc']], ['c', 'b', 'a']],
      ['name ascending', [['name', 'asc']], ['a', 'b', 'c']],
      ['a bare field name (ascending by default)', 'name', ['a', 'b', 'c']],
      ['a bare field name inside an array', ['name'], ['a', 'b', 'c']],
      ['id descending (id maps to the stored _id)', [['id', 'desc']], ['c', 'b', 'a']],
      ['id ascending', [['id', 'asc']], ['a', 'b', 'c']],
      ['category then name descending', [['category', 'asc'], ['name', 'desc']], ['b', 'a', 'c']],
    ])('returns records in the requested order when sorting by %s', async (_label, sorts, expectedIds) => {
      const col = await seed();
      const { data } = await col.query({ sorts: sorts as any });
      expect(data.ids()).toEqual(expectedIds);
    });

    it.each([
      [0, ['c', 'b']],
      [1, ['b', 'a']],
      [2, ['a']],
    ])('returns the correct page of sorted records at offset %i', async (offset, expectedIds) => {
      const col = await seed();
      const { data } = await col.query({ sorts: [['name', 'desc']], pagination: { offset, limit: 2 } });
      expect(data.ids()).toEqual(expectedIds);
    });

    it('pages through records with equal sort keys without repeating or skipping any, ordered by id', async () => {
      const col = await seed();
      const pages = await Promise.all([0, 1, 2].map(offset => col.query({ sorts: [['category', 'asc']], pagination: { offset, limit: 1 } })));
      expect(pages.flatMap(({ data }) => data.ids())).toEqual(['a', 'b', 'c']);
    });

    it('does not alter the filters passed by the caller', async () => {
      const col = await seed();
      const filters = { $or: [{ id: 'a' }, { id: { $in: ['c'] } }] };
      await col.query({ filters: filters as any });
      expect(filters).toEqual({ $or: [{ id: 'a' }, { id: { $in: ['c'] } }] });
    });

    it('returns records in insertion order when no sort is requested', async () => {
      const col = await seed();
      const { data } = await col.query({ filters: { category: { $in: ['x', 'y'] } } as any });
      expect(data.ids()).toEqual(['b', 'c', 'a']);
    });

    it('pages through records in insertion order when no sort is requested', async () => {
      const col = await seed();
      const { data } = await col.query({ pagination: { offset: 1, limit: 2 } });
      expect(data.ids()).toEqual(['c', 'a']);
    });

    // ── filter translation inside logical / array operators ──

    it.each([
      ['$or of ids', { $or: [{ id: 'a' }, { id: 'c' }] }, ['a', 'c']],
      ['$and of ids', { $and: [{ id: 'b' }, { category: 'x' }] }, ['b']],
      ['$nor of ids', { $nor: [{ id: 'a' }, { id: 'c' }] }, ['b']],
      ['$or nested inside $and', { $and: [{ category: 'x' }, { $or: [{ id: 'a' }, { id: 'c' }] }] }, ['a']],
      ['id with $in', { id: { $in: ['a', 'c'] } }, ['a', 'c']],
      ['id with $nin', { id: { $nin: ['a', 'c'] } }, ['b']],
    ])('matches the expected records for a filter using %s', async (_label, filters, expectedIds) => {
      const col = await seed();
      const { data } = await col.query({ filters: filters as any });
      expect(data.ids().sort()).toEqual(expectedIds);
    });

    it('counts matching records for an accurate total when the filter uses $or on id', async () => {
      const col = await seed();
      const { total } = await col.query({ filters: { $or: [{ id: 'a' }, { id: 'c' }] } as any, pagination: { limit: 1 }, getAccurateTotal: true });
      expect(total).toBe(2);
    });

    it('find translates id filters inside $or', async () => {
      const col = await seed();
      const result = await col.find({ $or: [{ id: 'zzz' }, { id: 'c' }] } as any);
      expect(result?.name).toBe('Charlie');
    });

    describe('Luxon DateTimes inside array operators', () => {
      const base = DateTime.fromISO('2024-01-10T00:00:00.000Z');
      const seedDated = async () => {
        const col = await makeCol();
        await col.upsert([
          makeItem({ id: 'old', name: 'Old', createdAt: base.minus({ days: 5 }) }),
          makeItem({ id: 'mid', name: 'Mid', createdAt: base }),
          makeItem({ id: 'new', name: 'New', createdAt: base.plus({ days: 5 }) }),
        ]);
        return col;
      };

      it.each([
        ['$in', () => ({ createdAt: { $in: [base.minus({ days: 5 }), base.plus({ days: 5 })] } }), ['new', 'old']],
        ['$nin', () => ({ createdAt: { $nin: [base.minus({ days: 5 }), base.plus({ days: 5 })] } }), ['mid']],
        ['$or', () => ({ $or: [{ createdAt: { $lt: base } }, { createdAt: { $gt: base } }] }), ['new', 'old']],
        ['$and', () => ({ $and: [{ createdAt: { $gte: base } }, { createdAt: { $lte: base } }] }), ['mid']],
      ])('matches records when DateTimes are used within %s', async (_label, makeFilters, expectedIds) => {
        const col = await seedDated();
        const { data } = await col.query({ filters: makeFilters() as any });
        expect(data.ids().sort()).toEqual(expectedIds);
      });
    });
  });

  describe('distinct options', () => {
    it('only considers records matching the filters', async () => {
      const col = await makeCol();
      await col.upsert([
        makeItem({ id: 'd1', name: 'One', category: 'cat-a', value: 1 }),
        makeItem({ id: 'd2', name: 'Two', category: 'cat-b', value: 1 }),
        makeItem({ id: 'd3', name: 'Three', category: 'cat-c', value: 2 }),
      ]);
      const results = await col.distinct({ field: 'category', filters: { value: 1 } as any });
      expect(results.map(record => record.category).sort()).toEqual(['cat-a', 'cat-b']);
    });

    it.each([
      ['desc', ['cat-c', 'cat-b', 'cat-a']],
      ['asc', ['cat-a', 'cat-b', 'cat-c']],
    ] as const)('returns distinct records sorted %s by the requested field', async (direction, expectedCategories) => {
      const col = await makeCol();
      await col.upsert([
        makeItem({ id: 'd1', name: 'One', category: 'cat-a' }),
        makeItem({ id: 'd2', name: 'Two', category: 'cat-c' }),
        makeItem({ id: 'd3', name: 'Three', category: 'cat-b' }),
        makeItem({ id: 'd4', name: 'Four', category: 'cat-a' }),
      ]);
      const results = await col.distinct({ field: 'category', sorts: [['category', direction]] });
      expect(results.map(record => record.category)).toEqual(expectedCategories);
    });

    it('translates id filters inside $or', async () => {
      const col = await makeCol();
      await col.upsert([
        makeItem({ id: 'd1', name: 'One', category: 'cat-a' }),
        makeItem({ id: 'd2', name: 'Two', category: 'cat-b' }),
        makeItem({ id: 'd3', name: 'Three', category: 'cat-c' }),
      ]);
      const results = await col.distinct({ field: 'category', filters: { $or: [{ id: 'd1' }, { id: 'd3' }] } as any, sorts: [['category', 'asc']] });
      expect(results.map(record => record.category)).toEqual(['cat-a', 'cat-c']);
    });
  });

  // ── index reconciliation ──────────────────────────────────────────────────

  describe('index configuration', () => {
    it('reconciles Mongo indexes with the declared ones, dropping stale and rebuilding changed indexes', async () => {
      const db = client.db('testdb');
      await db.collection(indexedCollection.name).drop().catch(() => { /* did not exist */ });
      const raw = await db.createCollection(indexedCollection.name);
      await raw.createIndex({ value: 1 }, { name: 'stale_index' });
      await raw.createIndex({ name: 1 }, { name: 'by_name', unique: false });
      await raw.createIndex({ category: 1 }, { name: 'by_category', sparse: true });

      new ServerDbCollection<TestItem>({
        getDb: () => Promise.resolve(db),
        collection: indexedCollection,
        collectionNames: Promise.resolve(new Set([indexedCollection.name])),
        logger: mockLogger,
      });

      const summarise = async () => (await raw.indexes())
        .map(index => ({ name: index.name, unique: index.unique === true, sparse: index.sparse === true }))
        .sort((left, right) => String(left.name).localeCompare(String(right.name)));
      await vi.waitFor(async () => expect(await summarise()).toEqual([
        { name: '_id_', unique: false, sparse: false },
        { name: 'by_category', unique: false, sparse: true },
        { name: 'by_name', unique: true, sparse: false },
      ]), AUDIT_WAIT);
    });
  });

  // ── audit trail (audited collections) ─────────────────────────────────────

  describe('audit trail', () => {
    const makeAudited = () => makeCol(auditedCollection);
    const auditEntryTypes = async (col: ServerDbCollection<TestItem>, id: string) => (await col.getAudit(id))?.entries.map(entry => entry.type);
    const waitForAuditTypes = (col: ServerDbCollection<TestItem>, id: string, expected: AuditEntryType[] | undefined) =>
      vi.waitFor(async () => expect(await auditEntryTypes(col, id)).toEqual(expected), AUDIT_WAIT);

    it('creates an audit with a Created entry when a record is first upserted', async () => {
      const col = await makeAudited();
      await col.upsert(makeItem({ id: 'au-1', name: 'First' }));
      await waitForAuditTypes(col, 'au-1', [AuditEntryType.Created]);
    });

    it('appends an Updated entry when an existing record changes', async () => {
      const col = await makeAudited();
      await col.upsert(makeItem({ id: 'au-2', name: 'First' }));
      await waitForAuditTypes(col, 'au-2', [AuditEntryType.Created]);

      await col.upsert(makeItem({ id: 'au-2', name: 'Second' }));

      await waitForAuditTypes(col, 'au-2', [AuditEntryType.Created, AuditEntryType.Updated]);
    });

    it('keeps the audit replayable to the latest record after an update', async () => {
      const col = await makeAudited();
      await col.upsert(makeItem({ id: 'au-3', name: 'First' }));
      await waitForAuditTypes(col, 'au-3', [AuditEntryType.Created]);

      await col.upsert(makeItem({ id: 'au-3', name: 'Second', value: 7 }));

      await vi.waitFor(async () => {
        const audit = await col.getAudit('au-3');
        expect(auditor.createRecordFrom(audit!)).toEqual(makeItem({ id: 'au-3', name: 'Second', value: 7 }));
      }, AUDIT_WAIT);
    });

    it('replaces the audit history with a single Created entry when resetAudit is requested', async () => {
      const col = await makeAudited();
      await col.upsert(makeItem({ id: 'au-4', name: 'First' }));
      await waitForAuditTypes(col, 'au-4', [AuditEntryType.Created]);
      await col.upsert(makeItem({ id: 'au-4', name: 'Second' }));
      await waitForAuditTypes(col, 'au-4', [AuditEntryType.Created, AuditEntryType.Updated]);

      await col.upsert(makeItem({ id: 'au-4', name: 'Third' }), { resetAudit: true });

      await waitForAuditTypes(col, 'au-4', [AuditEntryType.Created]);
    });

    it('starts an audit for a stored record that never had one', async () => {
      const col = await makeAudited();
      await client.db('testdb').collection(auditedCollection.name).insertOne({ _id: 'au-5' as any, name: 'Unaudited', value: 0 });

      await col.upsert(makeItem({ id: 'au-5', name: 'Now audited' }));

      await waitForAuditTypes(col, 'au-5', [AuditEntryType.Created]);
    });

    it('keeps the audit consistent with the new record when the stored record drifted from its audit', async () => {
      const col = await makeAudited();
      await col.upsert(makeItem({ id: 'au-6', name: 'Audited' }));
      await waitForAuditTypes(col, 'au-6', [AuditEntryType.Created]);
      // Change the stored record behind the audit's back (e.g. a manual DB edit).
      await client.db('testdb').collection(auditedCollection.name).updateOne({ _id: 'au-6' as any }, { $set: { name: 'Drifted' } });

      await col.upsert(makeItem({ id: 'au-6', name: 'Latest' }));

      await vi.waitFor(async () => {
        const audit = await col.getAudit('au-6');
        expect(auditor.createRecordFrom(audit!)).toEqual(makeItem({ id: 'au-6', name: 'Latest' }));
      }, AUDIT_WAIT);
    });

    it('resets a corrupt audit so it replays to the newly upserted record', async () => {
      const col = await makeAudited();
      const db = client.db('testdb');
      await db.collection(auditedCollection.name).insertOne({ _id: 'au-7' as any, name: 'Stored', value: 0 });
      await db.collection(AUDIT_COLLECTION_NAME).insertOne({ _id: 'au-7' as any, entries: [{ id: '01HZZZZZZZZZZZZZZZZZZZZZZZ', type: AuditEntryType.Created }] }); // Created entry missing its record payload

      await col.upsert(makeItem({ id: 'au-7', name: 'Latest' }));

      await vi.waitFor(async () => {
        const audit = await col.getAudit('au-7');
        expect(auditor.createRecordFrom(audit!)).toEqual(makeItem({ id: 'au-7', name: 'Latest' }));
      }, AUDIT_WAIT);
    });

    it('returns audits for several ids at once', async () => {
      const col = await makeAudited();
      await col.upsert([makeItem({ id: 'au-8', name: 'A' }), makeItem({ id: 'au-9', name: 'B' })]);
      await vi.waitFor(async () => expect((await col.getAudit(['au-8', 'au-9', 'au-missing'])).ids().sort()).toEqual(['au-8', 'au-9']), AUDIT_WAIT);
    });

    it('attributes audit entries to the system user when there is no authenticated user', async () => {
      const col = await makeAudited();
      await col.upsert(makeItem({ id: 'au-10', name: 'System' }));
      await vi.waitFor(async () => expect((await col.getAudit('au-10'))?.entries.map(entry => entry.userId)).toEqual(['__mxdb_system__']), AUDIT_WAIT);
    });

    it('attributes audit entries to the authenticated user', async () => {
      mockAuthenticatedUser.mockReturnValue({ id: 'user-42' });
      const col = await makeAudited();
      await col.upsert(makeItem({ id: 'au-11', name: 'Mine' }));
      await vi.waitFor(async () => expect((await col.getAudit('au-11'))?.entries.map(entry => entry.userId)).toEqual(['user-42']), AUDIT_WAIT);
    });

    it('appends a Deleted entry carrying the removed record when a record is removed', async () => {
      const col = await makeAudited();
      await col.upsert(makeItem({ id: 'au-12', name: 'Doomed' }));
      await waitForAuditTypes(col, 'au-12', [AuditEntryType.Created]);

      await col.remove('au-12');

      await vi.waitFor(async () => {
        const deleted = (await col.getAudit('au-12'))?.entries.find(entry => entry.type === AuditEntryType.Deleted);
        expect(deleted).toMatchObject({ record: makeItem({ id: 'au-12', name: 'Doomed' }) });
      }, AUDIT_WAIT);
    });

    it('stores the supplied delete snapshot on the Deleted entry', async () => {
      const col = await makeAudited();
      await col.upsert(makeItem({ id: 'au-13', name: 'Doomed' }));
      await waitForAuditTypes(col, 'au-13', [AuditEntryType.Created]);
      const snapshot = makeItem({ id: 'au-13', name: 'Snapshot from caller' });

      await col.remove('au-13', { deleteSnapshots: { 'au-13': snapshot } });

      await vi.waitFor(async () => {
        const deleted = (await col.getAudit('au-13'))?.entries.find(entry => entry.type === AuditEntryType.Deleted);
        expect(deleted).toMatchObject({ record: snapshot });
      }, AUDIT_WAIT);
    });

    it('removes the audit entirely when clearAudit is requested', async () => {
      const col = await makeAudited();
      await col.upsert(makeItem({ id: 'au-14', name: 'Gone' }));
      await waitForAuditTypes(col, 'au-14', [AuditEntryType.Created]);

      await col.remove('au-14', { clearAudit: true });

      await waitForAuditTypes(col, 'au-14', undefined);
    });

    it('clears every audit when the collection is cleared', async () => {
      const col = await makeAudited();
      await col.upsert([makeItem({ id: 'au-15', name: 'A' }), makeItem({ id: 'au-16', name: 'B' })]);
      await vi.waitFor(async () => expect(await col.getAudit(['au-15', 'au-16'])).toHaveLength(2), AUDIT_WAIT);

      await col.clear();

      await vi.waitFor(async () => expect(await col.getAudit(['au-15', 'au-16'])).toEqual([]), AUDIT_WAIT);
    });

    it('writes the supplied audit alongside the record during sync', async () => {
      const col = await makeAudited();
      const item = makeItem({ id: 'au-17', name: 'Synced' });
      const audit = auditor.createAuditFrom(item);

      await col.sync({ updated: [item], updatedAudits: [audit], removedIds: [] });

      expect((await col.getAudit('au-17'))?.entries.map(entry => entry.id)).toEqual(audit.entries.map(entry => entry.id));
    });

    it('snapshots the live record onto the Deleted entry when a sync deletes it', async () => {
      const col = await makeAudited();
      const item = makeItem({ id: 'au-18', name: 'Live' });
      const createdAudit = auditor.createAuditFrom(item);
      await col.sync({ updated: [item], updatedAudits: [createdAudit], removedIds: [] });

      await col.sync({ updated: [], updatedAudits: [auditor.delete(createdAudit)], removedIds: ['au-18'] });

      const deleted = (await col.getAudit('au-18'))?.entries.find(entry => entry.type === AuditEntryType.Deleted);
      expect(deleted).toMatchObject({ record: item });
    });
  });
});
