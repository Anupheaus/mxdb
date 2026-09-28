import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Record as MXDBRecord } from '@anupheaus/common';
import { seedCollections } from './seedCollections';
import { defineCollection } from '../../common/defineCollection';
import { extendCollection, type SeedWithFn, type SeedWithProps } from '../collections/extendCollection';
import type { MXDBCollection } from '../../common';

/** The database's seed hashes (`mxdb_seeds`), in memory: what a test starts with, and every save seeding makes. */
let storedHashes = new Map<string, string>();
const mockSaveSeedHash = vi.fn(async (collectionName: string, hash: string) => { storedHashes.set(collectionName, hash); });
const mockUseSeedState = vi.fn(async () => ({ hashes: new Map(storedHashes), save: mockSaveSeedHash }));
const mockUseCollection = vi.fn();
const mockUseLogger = vi.fn();

vi.mock('./seedState', () => ({ useSeedState: () => mockUseSeedState() }));
vi.mock('../collections', () => ({ useCollection: (c: unknown) => mockUseCollection(c) }));
vi.mock('@anupheaus/common', async importOriginal => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    useLogger: () => mockUseLogger(),
  };
});

// ─── Test data ────────────────────────────────────────────────────────────────

interface SeedItem extends MXDBRecord {
  name: string;
}

const makeItem = (id: string, name = `name-${id}`): SeedItem => ({ id, name });

/** In-memory stand-in for the server `useCollection` API (the persistence boundary for seeding). */
function createFakeCollectionApi(storedRecords: SeedItem[] = []) {
  const upsert = vi.fn(async (_records: SeedItem[], _props?: { resetAudit?: boolean }) => { /* recorded only */ });
  const getAll = vi.fn(async () => storedRecords.map(record => ({ ...record })));
  return { getAll, upsert, remove: vi.fn() };
}

let collectionCounter = 0;
/** Fresh collection per test so the module-level extension registry never leaks between tests. */
function makeCollection(): MXDBCollection<SeedItem> {
  collectionCounter += 1;
  return defineCollection<SeedItem>({ name: `seed_items_${collectionCounter}`, indexes: [] });
}

describe('seedCollections', () => {
  const mockInfo = vi.fn();
  const mockDebug = vi.fn();
  const mockSilly = vi.fn();
  const mockError = vi.fn();
  const mockCreateSubLogger = vi.fn();
  const mockLogger = {
    info: mockInfo,
    debug: mockDebug,
    silly: mockSilly,
    error: mockError,
    createSubLogger: mockCreateSubLogger,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSubLogger.mockReturnValue(mockLogger);
    storedHashes = new Map();
    mockUseLogger.mockReturnValue(mockLogger);
  });

  /** Registers `seedProps` as the collection's onSeed and runs seeding; returns what seedWith resolved to. */
  async function seedWith(collection: MXDBCollection<SeedItem>, seedProps: SeedWithProps<SeedItem>) {
    let result: SeedItem[] | undefined;
    extendCollection(collection, {
      onSeed: async (seed: SeedWithFn<SeedItem>) => { result = await seed(seedProps); },
    });
    await seedCollections([collection]);
    return result;
  }

  // ─── Orchestration ──────────────────────────────────────────────────────────

  it('records no hash for a collection whose onSeed seeds nothing', async () => {
    const collection = makeCollection();
    extendCollection(collection, { onSeed: async () => { /* nothing to seed */ } });
    mockUseCollection.mockReturnValue(createFakeCollectionApi());

    await seedCollections([collection]);

    expect(mockSaveSeedHash).not.toHaveBeenCalled();
  });

  it('seeds nothing, and logs why, when the seed state cannot be read', async () => {
    const collection = makeCollection();
    const onSeed = vi.fn();
    extendCollection(collection, { onSeed });
    mockUseSeedState.mockRejectedValueOnce(new Error('database unreachable'));

    await seedCollections([collection]);

    expect({ seeded: onSeed.mock.calls.length, errors: mockError.mock.calls.map(([message]) => message) })
      .toEqual({ seeded: 0, errors: ['Could not read the seed state; skipping seeding.'] });
  });

  it('does not touch the collection API for collections without an onSeed hook', async () => {
    const collection = makeCollection();
    await seedCollections([collection]);
    expect(mockUseCollection).not.toHaveBeenCalled();
  });

  it('passes a seedWith function to the onSeed hook', async () => {
    const collection = makeCollection();
    const onSeed = vi.fn();
    extendCollection(collection, { onSeed });
    mockUseCollection.mockReturnValue(createFakeCollectionApi());

    await seedCollections([collection]);

    expect(onSeed).toHaveBeenCalledWith(expect.any(Function));
  });

  it('continues seeding later collections when an earlier onSeed throws', async () => {
    const failing = makeCollection();
    const succeeding = makeCollection();
    extendCollection(failing, { onSeed: async () => { throw new Error('seed exploded'); } });
    const onSeed = vi.fn(async () => { /* ok */ });
    extendCollection(succeeding, { onSeed });
    mockUseCollection.mockReturnValue(createFakeCollectionApi());

    await seedCollections([failing, succeeding]);

    expect(onSeed).toHaveBeenCalledTimes(1);
  });

  it('logs an error naming the collection whose onSeed threw', async () => {
    const failing = makeCollection();
    extendCollection(failing, { onSeed: async () => { throw new Error('seed exploded'); } });
    mockUseCollection.mockReturnValue(createFakeCollectionApi());

    await seedCollections([failing]);

    expect(mockError).toHaveBeenCalledWith(`Error seeding collection "${failing.name}":`, expect.anything());
  });

  it('records no hash for fixed records whose write failed, so the next start retries them', async () => {
    const collection = makeCollection();
    const api = createFakeCollectionApi([]);
    api.upsert.mockRejectedValueOnce(new Error('write failed'));
    mockUseCollection.mockReturnValue(api);

    await seedWith(collection, { fixedRecords: [makeItem('f1')] });

    expect({ saved: mockSaveSeedHash.mock.calls.length, errored: mockError.mock.calls.length }).toEqual({ saved: 0, errored: 1 });
  });

  // ─── seedWith: argument validation ──────────────────────────────────────────

  describe('seedWith', () => {
    const invalidSeedProps: [string, SeedWithProps<SeedItem>, SeedItem[]][] = [
      ['neither count nor fixedRecords is supplied', {} as SeedWithProps<SeedItem>, []],
      ['count exceeds stored records and no create function is supplied', { count: 2, fixedRecords: [] }, [makeItem('s1')]],
      ['validate rejects a record and no create function is supplied', { fixedRecords: [makeItem('f1')], validate: () => false }, []],
    ];

    it.each(invalidSeedProps)('fails seeding (and writes nothing) when %s', async (_label, seedProps, stored) => {
      const collection = makeCollection();
      const api = createFakeCollectionApi(stored);
      mockUseCollection.mockReturnValue(api);

      await seedWith(collection, seedProps);

      expect({ upserted: api.upsert.mock.calls.length, errored: mockError.mock.calls.length }).toEqual({ upserted: 0, errored: 1 });
    });

    // ─── fixedRecords ─────────────────────────────────────────────────────────

    it('inserts fixed records that are not yet stored', async () => {
      const collection = makeCollection();
      const api = createFakeCollectionApi([]);
      mockUseCollection.mockReturnValue(api);
      const fixedRecords = [makeItem('f1'), makeItem('f2')];

      const result = await seedWith(collection, { fixedRecords });

      expect(result).toEqual(fixedRecords);
    });

    it('upserts seeded records with the audit reset', async () => {
      const collection = makeCollection();
      const api = createFakeCollectionApi([]);
      mockUseCollection.mockReturnValue(api);

      await seedWith(collection, { fixedRecords: [makeItem('f1')] });

      expect(api.upsert).toHaveBeenCalledWith([makeItem('f1')], { resetAudit: true });
    });

    it('only upserts fixed records that differ from what is stored', async () => {
      const collection = makeCollection();
      storedHashes.set(collection.name, 'hash-of-previous-fixed-records');
      const unchanged = makeItem('same', 'unchanged');
      const api = createFakeCollectionApi([unchanged, makeItem('changed', 'old')]);
      mockUseCollection.mockReturnValue(api);

      const result = await seedWith(collection, { fixedRecords: [unchanged, makeItem('changed', 'new')] });

      expect(result).toEqual([makeItem('changed', 'new')]);
    });

    it('records the new fixed-records hash under the collection name', async () => {
      const collection = makeCollection();
      mockUseCollection.mockReturnValue(createFakeCollectionApi([]));

      await seedWith(collection, { fixedRecords: [makeItem('f1')] });

      expect(mockSaveSeedHash).toHaveBeenCalledWith(collection.name, expect.any(String));
    });

    it('skips seeding when the fixed records are unchanged since the last run', async () => {
      const collection = makeCollection();
      const fixedRecords = [makeItem('f1')];
      mockUseCollection.mockReturnValue(createFakeCollectionApi([]));
      await seedWith(collection, { fixedRecords });

      const api = createFakeCollectionApi([]);
      mockUseCollection.mockReturnValue(api);
      await seedCollections([collection]);

      expect(api.getAll).not.toHaveBeenCalled();
    });

    it('re-seeds when the fixed records have changed since the last run', async () => {
      const collection = makeCollection();
      storedHashes.set(collection.name, 'hash-of-previous-fixed-records');
      const api = createFakeCollectionApi([]);
      mockUseCollection.mockReturnValue(api);

      const result = await seedWith(collection, { fixedRecords: [makeItem('f1')] });

      expect(result).toEqual([makeItem('f1')]);
    });

    // ─── adopting a database seeded before its hashes were kept in it ─────────

    it('adds only the missing fixed records, overwriting none, to a collection with records but no recorded hash', async () => {
      const collection = makeCollection();
      const edited = makeItem('f1', 'renamed in the app');
      const api = createFakeCollectionApi([edited]);
      mockUseCollection.mockReturnValue(api);

      const result = await seedWith(collection, { fixedRecords: [makeItem('f1'), makeItem('f2')] });

      expect({ result, upserted: api.upsert.mock.calls }).toEqual({ result: [makeItem('f2')], upserted: [[[makeItem('f2')], { resetAudit: true }]] });
    });

    it('records the hash when adopting, so the next start skips the collection', async () => {
      const collection = makeCollection();
      mockUseCollection.mockReturnValue(createFakeCollectionApi([makeItem('f1', 'renamed in the app')]));
      await seedWith(collection, { fixedRecords: [makeItem('f1')] });

      const api = createFakeCollectionApi([makeItem('f1', 'renamed in the app')]);
      mockUseCollection.mockReturnValue(api);
      await seedCollections([collection]);

      expect(api.getAll).not.toHaveBeenCalled();
    });

    it('seeds an empty collection with no recorded hash in full', async () => {
      const collection = makeCollection();
      mockUseCollection.mockReturnValue(createFakeCollectionApi([]));
      let created = 0;

      const result = await seedWith(collection, { count: 2, fixedRecords: [makeItem('f1')], create: () => makeItem(`c${++created}`) });

      expect(result).toEqual([makeItem('f1'), makeItem('c1')]);
    });

    // ─── count + create ──────────────────────────────────────────────────────

    it('creates just enough records to reach the requested count', async () => {
      const collection = makeCollection();
      mockUseCollection.mockReturnValue(createFakeCollectionApi([makeItem('s1')]));
      let createdCount = 0;
      const create = () => { createdCount += 1; return makeItem(`c${createdCount}`); };

      const result = await seedWith(collection, { count: 3, create });

      expect(result).toEqual([makeItem('c1'), makeItem('c2')]);
    });

    it('writes nothing new when the stored record count already meets the requested count', async () => {
      const collection = makeCollection();
      mockUseCollection.mockReturnValue(createFakeCollectionApi([makeItem('s1'), makeItem('s2')]));
      const create = vi.fn(() => makeItem('never'));

      const result = await seedWith(collection, { count: 2, create });

      expect({ result, created: create.mock.calls.length }).toEqual({ result: [], created: 0 });
    });

    it('tops up fixed records with created records when count exceeds the fixed set', async () => {
      const collection = makeCollection();
      mockUseCollection.mockReturnValue(createFakeCollectionApi([]));

      const result = await seedWith(collection, { count: 2, fixedRecords: [makeItem('f1')], create: () => makeItem('c1') });

      expect(result).toEqual([makeItem('f1'), makeItem('c1')]);
    });

    // ─── validate ────────────────────────────────────────────────────────────

    it('upserts the corrected record returned by validate', async () => {
      const collection = makeCollection();
      mockUseCollection.mockReturnValue(createFakeCollectionApi([makeItem('s1', 'bad')]));

      const result = await seedWith(collection, {
        count: 1,
        create: () => makeItem('never'),
        validate: record => (record.name === 'bad' ? { ...record, name: 'fixed' } : undefined),
      });

      expect(result).toEqual([makeItem('s1', 'fixed')]);
    });

    it('replaces a record rejected by validate with a newly created one that keeps the original id', async () => {
      const collection = makeCollection();
      mockUseCollection.mockReturnValue(createFakeCollectionApi([makeItem('s1', 'bad')]));

      const result = await seedWith(collection, {
        count: 1,
        create: () => makeItem('new-id', 'fresh'),
        validate: record => record.name !== 'bad',
      });

      expect(result).toEqual([makeItem('s1', 'fresh')]);
    });

    it.each([true, undefined])('leaves records alone when validate returns %p', async validation => {
      const collection = makeCollection();
      mockUseCollection.mockReturnValue(createFakeCollectionApi([makeItem('s1')]));

      const result = await seedWith(collection, { count: 1, create: () => makeItem('never'), validate: () => validation });

      expect(result).toEqual([]);
    });
  });
});
