import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NexusAuthRecord } from '@anupheaus/nexus/common';
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
    expect(mockInsertOne.mock.calls[0][0]).not.toHaveProperty('requestId');
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
