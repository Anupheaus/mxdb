import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GoogleOAuthAuthRecord } from '@anupheaus/nexus/common/auth';
import type { ServerDb } from '../providers';
import type { GoogleOAuthAuthCollection as GoogleOAuthAuthCollectionType } from './GoogleOAuthAuthCollection';

const mockFind = vi.fn();
const mockListCollections = vi.fn();
const mockGetCollection = vi.fn();

const fakeCollection = {
  insertOne: vi.fn(),
  findOne: vi.fn(),
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

let GoogleOAuthAuthCollection: new (db: ServerDb) => GoogleOAuthAuthCollectionType;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ GoogleOAuthAuthCollection } = await import('./GoogleOAuthAuthCollection'));
});

const baseRecord: GoogleOAuthAuthRecord = {
  requestId: 'req-1', sessionToken: 'tok', userId: 'u1',
  deviceId: 'dev', isEnabled: true,
  googleAccessToken: 'gat', googleRefreshToken: 'grt',
  googleTokenExpiresAt: 9999999, grantedScopes: ['openid'],
};

describe('GoogleOAuthAuthCollection', () => {
  it('findByUserId: returns undefined when no record exists for the user', async () => {
    mockFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
    const coll = new GoogleOAuthAuthCollection(makeFakeDb());
    expect(await coll.findByUserId('u1')).toBeUndefined();
  });

  it('findByUserId: returns the single record when one exists', async () => {
    mockFind.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([{ ...baseRecord, _id: 'req-1' }]),
    });
    const coll = new GoogleOAuthAuthCollection(makeFakeDb());
    const result = await coll.findByUserId('u1');
    expect(result).toEqual(expect.objectContaining({ requestId: 'req-1', googleAccessToken: 'gat' }));
    expect(result).not.toHaveProperty('_id');
  });

  it('findByUserId: returns the first record when multiple exist (defensive)', async () => {
    mockFind.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        { ...baseRecord, _id: 'req-1' },
        { ...baseRecord, _id: 'req-2', sessionToken: 'tok2' },
      ]),
    });
    const coll = new GoogleOAuthAuthCollection(makeFakeDb());
    const result = await coll.findByUserId('u1');
    expect(result).toEqual(expect.objectContaining({ requestId: 'req-1' }));
  });
});
