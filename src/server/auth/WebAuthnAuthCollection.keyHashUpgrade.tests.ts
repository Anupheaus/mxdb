import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { toStoredKeyHash } from '@anupheaus/nexus/server';
import type { WebAuthnAuthRecord } from '@anupheaus/nexus/common';
import type { ServerDb } from '../providers';
import { WebAuthnAuthCollection } from './WebAuthnAuthCollection';

// nexus stores a digest of each device's key hash (sc-613) and finds a device registered before that by its raw value.
// mxdb brings every existing auth collection up to date the first time it opens it: raw key hashes become nexus's
// digest, and one key hash can belong to one device only (a unique index, over records that have one). Against a real
// MongoDB, because the index and the update are the behaviour under test.

let mongod: MongoMemoryServer;
let client: MongoClient;
let dbCount = 0;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

let db: Db;
beforeEach(() => { db = client.db(`key_hash_upgrade_${++dbCount}`); });

const coll = () => db.collection('mxdb_authentication');
const openAuthCollection = () => new WebAuthnAuthCollection({ getMongoDb: async () => db } as unknown as ServerDb);

/** An auth collection as an earlier mxdb left it: a sparse, non-unique keyHash index. */
async function earlierCollection(records: object[]) {
  await db.createCollection('mxdb_authentication');
  await coll().createIndex({ keyHash: 1 }, { sparse: true });
  if (records.length > 0) await coll().insertMany(records as never[]);
}

const device = (id: string, keyHash?: string | null) => ({ _id: id, userId: 'u', deviceId: 'd', sessionToken: `s-${id}`, isEnabled: true, ...(keyHash !== undefined ? { keyHash } : {}) });
const keyHashIndex = async () => (await coll().indexes()).find(index => index.name === 'keyHash_1');

describe('opening an existing auth collection', () => {
  it('turns every raw key hash into nexus\'s digest, leaving digests and invites without one alone', async () => {
    const digest = toStoredKeyHash('already');
    await earlierCollection([device('raw-1', 'raw-a'), device('raw-2', 'raw-b'), device('digested', digest), device('invite'), device('nulled', null)]);

    await openAuthCollection().findById('raw-1');

    const keyHashes = Object.fromEntries((await coll().find({}).toArray()).map(({ _id, keyHash }) => [_id, keyHash]));
    expect(keyHashes).toEqual({ 'raw-1': toStoredKeyHash('raw-a'), 'raw-2': toStoredKeyHash('raw-b'), digested: digest, invite: undefined, nulled: null });
  });

  // toStoredKeyHash does not skip a value that is already a digest: re-hashing one would lock its device out for good.
  it('never re-hashes a digest, however many times a collection is opened', async () => {
    await earlierCollection([device('raw-1', 'raw-a')]);

    await openAuthCollection().findById('raw-1');
    await openAuthCollection().findById('raw-1');

    expect((await coll().findOne({ _id: 'raw-1' as never }))?.keyHash).toBe(toStoredKeyHash('raw-a'));
  });

  it('then signs a migrated device in by its digest', async () => {
    await earlierCollection([device('raw-1', 'raw-a')]);

    expect((await openAuthCollection().findByKeyHash(toStoredKeyHash('raw-a')))?.requestId).toBe('raw-1');
  });

  it('makes a key hash belong to one device only, while any number of invites have none', async () => {
    await earlierCollection([device('raw-1', 'raw-a'), device('invite-1'), device('invite-2')]);
    const authColl = openAuthCollection();
    await authColl.findById('raw-1');

    const duplicate = await coll().insertOne(device('copy', toStoredKeyHash('raw-a')) as never).then(() => 'inserted', (error: { code?: number; }) => error.code);
    await authColl.create({ requestId: 'invite-3', userId: 'u', deviceId: '', sessionToken: '', isEnabled: false } as WebAuthnAuthRecord);

    expect({ index: (await keyHashIndex())?.unique, duplicate, invites: await coll().countDocuments({ keyHash: { $exists: false } }) })
      .toEqual({ index: true, duplicate: 11000, invites: 3 });
  });

  it('leaves the index as it was, without failing, when two devices already share a key hash', async () => {
    await earlierCollection([device('a', 'same'), device('b', 'same')]);

    const found = await openAuthCollection().findById('a');

    expect({ found: found?.requestId, unique: (await keyHashIndex())?.unique ?? false }).toEqual({ found: 'a', unique: false });
  });
});

describe('a new auth collection', () => {
  it('is created with the unique key hash index', async () => {
    await openAuthCollection().findById('nothing');

    expect({ unique: (await keyHashIndex())?.unique, partial: (await keyHashIndex())?.partialFilterExpression }).toEqual({
      unique: true, partial: { keyHash: { $type: 'string' } },
    });
  });
});
