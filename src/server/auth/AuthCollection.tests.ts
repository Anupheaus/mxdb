import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NexusAuthRecord } from '@anupheaus/nexus/common';
import { createAsyncContext } from '@anupheaus/nexus/server';
import { setDb } from '../providers';
import type { ServerDb } from '../providers';
import type { AuthCollection as AuthCollectionType } from './AuthCollection';

const mockInsertOne = vi.fn();
const mockFindOne = vi.fn();
const mockFind = vi.fn();
const mockUpdateOne = vi.fn();
const mockDeleteOne = vi.fn();
const mockListCollections = vi.fn();
const mockGetCollection = vi.fn();

const fakeCollection = {
  insertOne: mockInsertOne,
  findOne: mockFindOne,
  find: mockFind,
  updateOne: mockUpdateOne,
  deleteOne: mockDeleteOne,
  createIndex: vi.fn(),
};

function makeFakeDb(): ServerDb {
  mockListCollections.mockReturnValue({
    toArray: vi.fn().mockResolvedValue([{ name: 'mxdb_authentication' }]),
  });
  mockGetCollection.mockReturnValue(fakeCollection);
  return {
    getMongoDb: vi.fn().mockResolvedValue({
      listCollections: mockListCollections,
      createCollection: vi.fn().mockResolvedValue(fakeCollection),
      collection: mockGetCollection,
    }),
  } as unknown as ServerDb;
}

let ConcreteCollection: new (db: ServerDb) => AuthCollectionType<NexusAuthRecord>;

beforeEach(async () => {
  vi.clearAllMocks();
  const { AuthCollection } = await import('./AuthCollection');
  // Minimal concrete subclass — satisfies abstract constraint for testing base behaviour
  ConcreteCollection = class extends AuthCollection<NexusAuthRecord> { };
});

describe('AuthCollection (base class)', () => {
  it('create: inserts doc with _id = requestId and no requestId field', async () => {
    const coll = new ConcreteCollection(makeFakeDb());
    const record: NexusAuthRecord = {
      requestId: 'req-1', sessionToken: 'tok', userId: 'u1',
      deviceId: 'dev', isEnabled: true,
    };
    await coll.create(record);
    expect(mockInsertOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'req-1', sessionToken: 'tok' })
    );
    expect(mockInsertOne.mock.calls[0]![0]).not.toHaveProperty('requestId');
  });

  it('findById: returns undefined when document not found', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new ConcreteCollection(makeFakeDb());
    expect(await coll.findById('missing')).toBeUndefined();
  });

  it('findById: maps _id back to requestId', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'req-1', sessionToken: 'tok', userId: 'u1', deviceId: 'dev', isEnabled: true,
    });
    const coll = new ConcreteCollection(makeFakeDb());
    const result = await coll.findById('req-1');
    expect(result).toEqual(expect.objectContaining({ requestId: 'req-1' }));
    expect(result).not.toHaveProperty('_id');
  });

  it('findBySessionToken: queries by sessionToken field', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new ConcreteCollection(makeFakeDb());
    await coll.findBySessionToken('tok');
    expect(mockFindOne).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: 'tok' }));
  });

  it('findByDevice: queries by userId and deviceId', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new ConcreteCollection(makeFakeDb());
    await coll.findByDevice('u1', 'dev');
    expect(mockFindOne).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', deviceId: 'dev' }));
  });

  it('findAllByUserId: returns all matching records mapped from docs', async () => {
    const coll = new ConcreteCollection(makeFakeDb());
    // Override mockFind after makeFakeDb() so the two-item result isn't clobbered by
    // the empty-array default that makeFakeDb() installs on mockFind.
    mockFind.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        { _id: 'req-1', sessionToken: 't1', userId: 'u1', deviceId: 'd1', isEnabled: true },
        { _id: 'req-2', sessionToken: 't2', userId: 'u1', deviceId: 'd2', isEnabled: true },
      ]),
    });
    const results = await coll.findAllByUserId('u1');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(expect.objectContaining({ requestId: 'req-1' }));
    expect(results[1]).toEqual(expect.objectContaining({ requestId: 'req-2' }));
  });

  it('update: $set valued fields and $unset undefined fields', async () => {
    const coll = new ConcreteCollection(makeFakeDb());
    await coll.update('req-1', { sessionToken: 'new', deviceDetails: undefined });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'req-1' }),
      expect.objectContaining({ $set: { sessionToken: 'new' }, $unset: { deviceDetails: 1 } })
    );
  });

  it('update: does not call updateOne when patch is empty', async () => {
    const coll = new ConcreteCollection(makeFakeDb());
    await coll.update('req-1', {});
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('delete: removes document by requestId', async () => {
    const coll = new ConcreteCollection(makeFakeDb());
    await coll.delete('req-1');
    expect(mockDeleteOne).toHaveBeenCalledWith({ _id: 'req-1' });
  });

  it('findStalePendingInvites: queries disabled invites without device or last connection', async () => {
    mockFind.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        { _id: 'invite-1', sessionToken: 't1', userId: 'u1', deviceId: 'd1', isEnabled: false, createdAt: 1 },
      ]),
    });
    const coll = new ConcreteCollection(makeFakeDb());
    const results = await coll.findStalePendingInvites(1_000);
    expect(mockFind).toHaveBeenCalledWith({
      isEnabled: false,
      deviceDetails: { $exists: false },
      lastConnectedAt: { $exists: false },
      createdAt: { $lt: 1_000 },
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({ requestId: 'invite-1' }));
  });
});

/**
 * Phase 2b: queries must resolve the ServerDb via `useDb()` at call time (per-connection
 * routing, Phase 2a's `setDb`), not the db captured by the constructor. Each fake db here has
 * its own independent Mongo mocks (unlike `makeFakeDb()` above, which shares module-level
 * mocks) so a query hitting the wrong db is directly observable.
 *
 * `wrap()` below is obtained purely to enter a nested async-context scope — it shares nexus's
 * module-level `chainStorage` with mxdb's real `setDb`/`useDb`, so this is the same mechanism
 * nexus's own per-connection `wrap()` uses around `onClientConnected` in production (see
 * `connectionDbRouter.ts`'s `resolveAndScopeConnection` and `startAuthenticatedServer.ts`).
 */
describe('AuthCollection — per-connection routing via useDb()', () => {
  const { wrap } = createAsyncContext({});

  function makeDistinctFakeDb(doc: unknown): { db: ServerDb; findOne: ReturnType<typeof vi.fn> } {
    const findOne = vi.fn().mockResolvedValue(doc);
    const collection = {
      findOne,
      insertOne: vi.fn(),
      find: vi.fn(),
      updateOne: vi.fn(),
      deleteOne: vi.fn(),
      createIndex: vi.fn(),
    };
    const db = {
      getMongoDb: vi.fn().mockResolvedValue({
        listCollections: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([{ name: 'mxdb_authentication' }]) }),
        createCollection: vi.fn().mockResolvedValue(collection),
        collection: vi.fn().mockReturnValue(collection),
      }),
    } as unknown as ServerDb;
    return { db, findOne };
  }

  it('queries the ServerDb set inside the current connection scope, not the constructor-captured db', async () => {
    const constructorDb = makeDistinctFakeDb({ _id: 'ctor', sessionToken: 'ctor-tok', userId: 'u', deviceId: 'd', isEnabled: true });
    const tenantDb = makeDistinctFakeDb({ _id: 'tenant', sessionToken: 'tenant-tok', userId: 'u', deviceId: 'd', isEnabled: true });
    const coll = new ConcreteCollection(constructorDb.db);

    let result: NexusAuthRecord | undefined;
    await wrap(() => ({}), async () => {
      setDb(tenantDb.db); // mirrors Phase 2a's router calling setDb inside the connection scope
      result = await coll.findById('anything');
    })();

    expect(result).toEqual(expect.objectContaining({ requestId: 'tenant' }));
    expect(tenantDb.findOne).toHaveBeenCalledTimes(1);
    expect(constructorDb.findOne).not.toHaveBeenCalled();
  });

  it('routes two different tenant scopes on the SAME long-lived AuthCollection instance to their own db', async () => {
    const constructorDb = makeDistinctFakeDb({ _id: 'ctor', sessionToken: 'ctor-tok', userId: 'u', deviceId: 'd', isEnabled: true });
    const tenantA = makeDistinctFakeDb({ _id: 'tenant-a', sessionToken: 'a-tok', userId: 'u', deviceId: 'd', isEnabled: true });
    const tenantB = makeDistinctFakeDb({ _id: 'tenant-b', sessionToken: 'b-tok', userId: 'u', deviceId: 'd', isEnabled: true });
    const coll = new ConcreteCollection(constructorDb.db);

    let resultA: NexusAuthRecord | undefined;
    let resultB: NexusAuthRecord | undefined;
    await wrap(() => ({}), async () => {
      setDb(tenantA.db);
      resultA = await coll.findById('a');
    })();
    await wrap(() => ({}), async () => {
      setDb(tenantB.db);
      resultB = await coll.findById('b');
    })();

    expect(resultA).toEqual(expect.objectContaining({ requestId: 'tenant-a' }));
    expect(resultB).toEqual(expect.objectContaining({ requestId: 'tenant-b' }));
    expect(tenantA.findOne).toHaveBeenCalledTimes(1);
    expect(tenantB.findOne).toHaveBeenCalledTimes(1);
    expect(constructorDb.findOne).not.toHaveBeenCalled();
  });

  // Kept last in this file: sets the REAL global default (no active scope), which persists
  // for the remainder of the module's lifetime — later tests in THIS file must not depend on
  // no global being set.
  it('falls back to the global default ServerDb (set by provideDb at startup) outside any connection scope', async () => {
    const constructorDb = makeDistinctFakeDb({ _id: 'ctor', sessionToken: 'ctor-tok', userId: 'u', deviceId: 'd', isEnabled: true });
    const globalDb = makeDistinctFakeDb({ _id: 'global', sessionToken: 'global-tok', userId: 'u', deviceId: 'd', isEnabled: true });
    const coll = new ConcreteCollection(constructorDb.db);

    setDb(globalDb.db); // called with no active scope → sets the global default, exactly like provideDb() at startup

    const result = await coll.findById('anything');

    expect(result).toEqual(expect.objectContaining({ requestId: 'global' }));
    expect(globalDb.findOne).toHaveBeenCalledTimes(1);
    expect(constructorDb.findOne).not.toHaveBeenCalled();
  });
});
