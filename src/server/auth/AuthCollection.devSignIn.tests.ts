import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { WebAuthnAuthRecord } from '@anupheaus/nexus/common';
import type { ServerDb } from '../providers';
import { WebAuthnAuthCollection } from './WebAuthnAuthCollection';

// The dev sign-in route's records (`dev-bypass-<userId>`) are enabled devices with live session tokens. Once the route is
// off they must go, and nothing else with them. Against a real MongoDB, because the match is a regex on _id.

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let authColl: WebAuthnAuthCollection;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db('dev_sign_in_records');
  authColl = new WebAuthnAuthCollection({ getMongoDb: async () => db } as unknown as ServerDb);
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

const device = (requestId: string, userId: string) =>
  ({ requestId, userId, deviceId: 'd', sessionToken: `s-${requestId}`, isEnabled: true } as WebAuthnAuthRecord);

describe('AuthCollection.deleteDevSignInRecords', () => {
  it('deletes every dev sign-in record, and only those', async () => {
    await authColl.create(device('dev-bypass-alice', 'alice'));
    await authColl.create(device('dev-bypass-bob', 'bob'));
    await authColl.create(device('r-real', 'alice'));
    await authColl.create(device('my-dev-bypass-lookalike', 'carol'));

    const removed = await authColl.deleteDevSignInRecords();
    const left = (await db.collection('mxdb_authentication').find({}).toArray()).map(({ _id }) => _id).sort();

    expect({ removed, left }).toEqual({ removed: 2, left: ['my-dev-bypass-lookalike', 'r-real'] });
  });
});
