import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { defineCollection } from '../../../common/defineCollection';
import { provideDb } from './provideDb';
import { ServerDb } from './ServerDb';
import { useDb, useServerToClientSynchronisation } from './DbContext';

// ─── External boundaries ──────────────────────────────────────────────────────

// `useLogger()` throws under this repo's global JSDOM `window` (see withDb.tests.ts) — stub it.
const mockUseLogger = vi.fn();
vi.mock('@anupheaus/common', async importOriginal => {
  const actual = await importOriginal() as object;
  return { ...actual, useLogger: () => mockUseLogger() };
});

/** Minimal in-memory Mongo `Db` — just enough for ServerDb/ServerDbCollection start-up. */
function createFakeMongoDb() {
  const fakeCollection = (name: string) => ({ collectionName: name, indexes: async () => [], createIndex: async () => name, dropIndex: async () => ({}) });
  return {
    watch: vi.fn(() => Object.assign(new EventEmitter(), { close: async () => { /* closed */ } })),
    listCollections: () => ({ toArray: async () => [] }),
    collection: fakeCollection,
    createCollection: async (name: string) => fakeCollection(name),
    command: async () => ({ ok: 1 }),
  };
}

let fakeMongoDb = createFakeMongoDb();
const mongoClientUrls: string[] = [];
vi.mock('mongodb', () => ({
  MongoClient: class extends EventEmitter {
    constructor(url: string) { super(); mongoClientUrls.push(url); }
    async connect() { return this; }
    db() { return fakeMongoDb; }
    async close() { /* closed */ }
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

const collections = [defineCollection({ name: 'provide_db_items', indexes: [] })];
const MONGO_URL = 'mongodb://fake-host:27017';

describe('provideDb', () => {
  const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn(), silly: vi.fn(), createSubLogger: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    logger.createSubLogger.mockReturnValue(logger);
    mockUseLogger.mockReturnValue(logger);
    fakeMongoDb = createFakeMongoDb();
    mongoClientUrls.length = 0;
  });

  it('returns whatever the delegate returns', () => {
    const result = provideDb('db-name', MONGO_URL, collections, () => 'delegate-result');
    expect(result).toBe('delegate-result');
  });

  it('hands the delegate a ServerDb exposing the configured collections', () => {
    const collectionName = provideDb('db-name', MONGO_URL, collections, db => (db instanceof ServerDb ? db.use('provide_db_items')?.name : undefined));
    expect(collectionName).toBe('provide_db_items');
  });

  it('connects to the supplied MongoDB url', () => {
    provideDb('db-name', MONGO_URL, collections, () => undefined);
    expect(mongoClientUrls).toEqual([MONGO_URL]);
  });

  it('makes the new ServerDb the ambient db for the delegate', () => {
    const isAmbient = provideDb('db-name', MONGO_URL, collections, db => useDb() === db);
    expect(isAmbient).toBe(true);
  });

  it('installs a no-op server-to-client sync for the delegate', () => {
    const isNoOp = provideDb('db-name', MONGO_URL, collections, () => useServerToClientSynchronisation().isNoOp);
    expect(isNoOp).toBe(true);
  });

  it('starts the change-stream watcher by default', async () => {
    await provideDb('db-name', MONGO_URL, collections, db => db.getMongoDb());
    expect(fakeMongoDb.watch).toHaveBeenCalledTimes(1);
  });

  it('does not start the change-stream watcher when watch is false', async () => {
    await provideDb('db-name', MONGO_URL, collections, db => db.getMongoDb(), { watch: false });
    expect(fakeMongoDb.watch).not.toHaveBeenCalled();
  });
});
