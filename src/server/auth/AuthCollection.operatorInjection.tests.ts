import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { WebAuthnAuthRecord } from '@anupheaus/nexus/common';
import type { ServerDb } from '../providers';
import { WebAuthnAuthCollection } from './WebAuthnAuthCollection';
import { GoogleOAuthAuthCollection } from './GoogleOAuthAuthCollection';

// Auth keys reach these lookups from REST bodies and socket handshakes, i.e. parsed JSON. Placed in a MongoDB filter, an
// object such as { "$ne": null } is an operator: `findByKeyHash({ $ne: null })` would return the first registered device,
// and nexus would sign the caller in as it (Vision sc-620). Every lookup must find nothing, and every write must refuse,
// for any key that is not a non-empty string. These run against a real MongoDB, because what an operator matches is the
// behaviour under test.

/** Everything a JSON body or handshake can carry in place of a string key. */
const NOT_KEYS: [string, unknown][] = [
  ['{ $ne: null }', { $ne: null }],
  ['{ $gt: "" }', { $gt: '' }],
  ['{ $exists: true }', { $exists: true }],
  ['{ $regex: ".*" }', { $regex: '.*' }],
  ['{ $in: [...] }', { $in: ['session-1', 'hash-1', 'tok-1', 'r-device', 'u1'] }],
  ['an array', ['session-1']],
  ['a number', 1],
  ['true', true],
  ['null', null],
  ['undefined', undefined],
  ['an empty string', ''],
];

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let webauthn: WebAuthnAuthCollection;
let google: GoogleOAuthAuthCollection;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db('auth_operator_injection');
  const serverDb = { getMongoDb: async () => db } as unknown as ServerDb;
  webauthn = new WebAuthnAuthCollection(serverDb);
  google = new GoogleOAuthAuthCollection(serverDb);
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

/** A registered device and an opened invite: the records an operator would match. */
beforeEach(async () => {
  await db.collection('mxdb_authentication').deleteMany({});
  await webauthn.create({
    requestId: 'r-device', userId: 'u1', deviceId: 'd1', sessionToken: 'session-1', keyHash: 'hash-1', isEnabled: true, createdAt: 1,
  } as WebAuthnAuthRecord);
  await webauthn.create({
    requestId: 'r-invite', userId: 'u2', deviceId: '', sessionToken: '', registrationToken: 'tok-1', isEnabled: false, createdAt: Date.now(),
  } as WebAuthnAuthRecord);
});

const records = async () => db.collection('mxdb_authentication').find({}).sort({ _id: 1 }).toArray();

describe('auth lookups refuse any key that is not a non-empty string', () => {
  it.each(NOT_KEYS)('find nothing for %s', async (_label, key) => {
    const asKey = key as string;

    expect({
      findById: await webauthn.findById(asKey),
      findBySessionToken: await webauthn.findBySessionToken(asKey),
      findByRegistrationToken: await webauthn.findByRegistrationToken(asKey),
      findByKeyHash: await webauthn.findByKeyHash(asKey),
      findByDeviceUser: await webauthn.findByDevice(asKey, 'd1'),
      findByDeviceDevice: await webauthn.findByDevice('u1', asKey),
      findAllByUserId: await webauthn.findAllByUserId(asKey),
      findByUserId: await webauthn.findByUserId(asKey),
      googleFindByUserId: await google.findByUserId(asKey),
    }).toEqual({
      findById: undefined,
      findBySessionToken: undefined,
      findByRegistrationToken: undefined,
      findByKeyHash: undefined,
      findByDeviceUser: undefined,
      findByDeviceDevice: undefined,
      findAllByUserId: [],
      findByUserId: [],
      googleFindByUserId: undefined,
    });
  });

  it.each(NOT_KEYS)('claim no registration for %s, and change nothing', async (_label, key) => {
    const before = await records();

    const claimed = await webauthn.claimRegistration(key as string, { keyHash: 'attacker', isEnabled: true, sessionToken: 'attacker' });

    expect({ claimed, after: await records() }).toEqual({ claimed: undefined, after: before });
  });

  it.each(NOT_KEYS)('refuse to update or delete by %s, and change nothing', async (_label, key) => {
    const before = await records();

    await expect(webauthn.update(key as string, { isEnabled: false })).rejects.toThrow('the request id must be a non-empty string');
    await expect(webauthn.delete(key as string)).rejects.toThrow('the request id must be a non-empty string');
    expect(await records()).toEqual(before);
  });

  it.each([['a string', '1800000000000'], ['NaN', Number.NaN], ['an operator', { $gt: 0 }]])('find no stale invites before %s', async (_label, createdBefore) => {
    expect(await webauthn.findStalePendingInvites(createdBefore as number)).toEqual([]);
  });

  it('claims nothing when createdSince is not a finite number', async () => {
    expect(await webauthn.claimRegistration('tok-1', { keyHash: 'k' }, { createdSince: { $gt: 0 } as unknown as number })).toBeUndefined();
  });

  it('still finds, claims, updates and deletes by genuine string keys', async () => {
    const found = [
      (await webauthn.findById('r-device'))?.requestId,
      (await webauthn.findBySessionToken('session-1'))?.requestId,
      (await webauthn.findByKeyHash('hash-1'))?.requestId,
      (await webauthn.findByDevice('u1', 'd1'))?.requestId,
      (await webauthn.findByRegistrationToken('tok-1'))?.requestId,
      (await google.findByUserId('u1'))?.requestId,
    ];
    const claimed = (await webauthn.claimRegistration('tok-1', { keyHash: 'hash-2', isEnabled: true }))?.requestId;
    await webauthn.update('r-device', { isEnabled: false });
    await webauthn.delete('r-invite');

    expect({ found, claimed, left: (await records()).map(({ _id, isEnabled }) => [_id, isEnabled]) }).toEqual({
      found: ['r-device', 'r-device', 'r-device', 'r-device', 'r-invite', 'r-device'],
      claimed: 'r-invite',
      left: [['r-device', false]],
    });
  });
});
