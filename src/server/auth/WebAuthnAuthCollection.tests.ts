import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebAuthnAuthRecord } from '@anupheaus/nexus/common/auth';
import type { ServerDb } from '../providers';
import type { WebAuthnAuthCollection as WebAuthnAuthCollectionType } from './WebAuthnAuthCollection';

const mockFindOne = vi.fn();
const mockFind = vi.fn();
const mockListCollections = vi.fn();
const mockGetCollection = vi.fn();

const fakeCollection = {
  insertOne: vi.fn(),
  findOne: mockFindOne,
  find: mockFind,
  updateOne: vi.fn(),
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

let WebAuthnAuthCollection: new (db: ServerDb) => WebAuthnAuthCollectionType;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ WebAuthnAuthCollection } = await import('./WebAuthnAuthCollection'));
});

const baseDoc = {
  _id: 'req-1', sessionToken: 'tok', userId: 'u1',
  deviceId: 'dev', isEnabled: true,
};

describe('WebAuthnAuthCollection', () => {
  it('findByRegistrationToken: queries by registrationToken field', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new WebAuthnAuthCollection(makeFakeDb());
    await coll.findByRegistrationToken('reg-tok');
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ registrationToken: 'reg-tok' })
    );
  });

  it('findByRegistrationToken: returns undefined when not found', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new WebAuthnAuthCollection(makeFakeDb());
    expect(await coll.findByRegistrationToken('none')).toBeUndefined();
  });

  it('findByRegistrationToken: maps _id back to requestId', async () => {
    mockFindOne.mockResolvedValue({ ...baseDoc, registrationToken: 'reg-tok' });
    const coll = new WebAuthnAuthCollection(makeFakeDb());
    const result = await coll.findByRegistrationToken('reg-tok');
    expect(result).toEqual(expect.objectContaining({ requestId: 'req-1' }));
    expect(result).not.toHaveProperty('_id');
  });

  it('findByKeyHash: queries by keyHash field', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new WebAuthnAuthCollection(makeFakeDb());
    await coll.findByKeyHash('hash-abc');
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ keyHash: 'hash-abc' })
    );
  });

  it('findByKeyHash: returns undefined when not found', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new WebAuthnAuthCollection(makeFakeDb());
    expect(await coll.findByKeyHash('none')).toBeUndefined();
  });

  it('findByUserId: returns all records for a userId as an array', async () => {
    mockFind.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        { ...baseDoc },
        { ...baseDoc, _id: 'req-2', sessionToken: 'tok2', deviceId: 'dev2' },
      ]),
    });
    const coll = new WebAuthnAuthCollection(makeFakeDb());
    const results = await coll.findByUserId('u1');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(expect.objectContaining({ requestId: 'req-1' }));
    expect(results[1]).toEqual(expect.objectContaining({ requestId: 'req-2' }));
  });
});
