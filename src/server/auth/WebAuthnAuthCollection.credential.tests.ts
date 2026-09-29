import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { WebAuthnAuthRecord } from '@anupheaus/nexus/common';
import type { ServerDb } from '../providers';
import { WebAuthnAuthCollection } from './WebAuthnAuthCollection';

// sc-627: a device signs in by its passkey's signature, found by the passkey's credential id. The store finds devices by
// credential id, keeps one device per credential, records a sign-in only if its challenge is newer than the device's last
// (in one atomic write), and never lets a registered device's invite be claimed again. Against a real MongoDB, because
// the filters and indexes are the behaviour under test.

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let authColl: WebAuthnAuthCollection;
let dbCount = 0;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  db = client.db(`credential_${++dbCount}`);
  authColl = new WebAuthnAuthCollection({ getMongoDb: async () => db } as unknown as ServerDb);
  await authColl.create({
    requestId: 'device', userId: 'u1', deviceId: 'd1', sessionToken: 's1', isEnabled: true,
    credentialId: 'cred-1', credentialPublicKey: 'pk-1', credentialCounter: 0,
  } as WebAuthnAuthRecord);
});

const outcome = (write: Promise<unknown>) => write.then(value => value, (error: Error) => error.message);
const stored = () => db.collection('mxdb_authentication').findOne({ _id: 'device' as never });

describe('findByCredentialId', () => {
  it('finds the device whose passkey has the credential id', async () => {
    expect((await authColl.findByCredentialId('cred-1'))?.requestId).toBe('device');
  });

  it.each([[{ $ne: null }], [{ $gt: '' }], [['cred-1']], [1], [''], [null]])('finds nothing for %j, which is not a credential id', async id => {
    expect(await authColl.findByCredentialId(id as never)).toBeUndefined();
  });
});

describe('one device per passkey', () => {
  it('refuses a second device with the same credential id, in plain words', async () => {
    const error = await outcome(authColl.create({ requestId: 'copy', userId: 'u2', deviceId: 'd2', sessionToken: 's2', isEnabled: true, credentialId: 'cred-1' } as WebAuthnAuthRecord));
    expect(error).toBe('Passkey already registered');
  });

  it('still allows any number of pending invites, which have no credential', async () => {
    const invite = (id: string) => authColl.create({ requestId: id, userId: 'u3', deviceId: '', sessionToken: '', isEnabled: false } as WebAuthnAuthRecord);
    expect([await outcome(invite('i1')), await outcome(invite('i2'))]).toEqual([undefined, undefined]);
  });

  it('gives an existing collection the unique credential index when it is first opened', async () => {
    const earlier = client.db(`credential_earlier_${dbCount}`);
    await earlier.createCollection('mxdb_authentication');
    await new WebAuthnAuthCollection({ getMongoDb: async () => earlier } as unknown as ServerDb).findById('x');

    const index = (await earlier.collection('mxdb_authentication').indexes()).find(({ name }) => name === 'credentialId_1');
    expect({ unique: index?.unique, partial: index?.partialFilterExpression }).toEqual({ unique: true, partial: { credentialId: { $type: 'string' } } });
  });
});

describe('recordSignIn', () => {
  it('records a sign-in whose challenge is newer than the device\'s last, with its patch', async () => {
    const wrote = await authColl.recordSignIn('device', 1_000, { sessionToken: 's2', credentialCounter: 3 });
    const after = await stored();
    expect({ wrote, session: after?.sessionToken, counter: after?.credentialCounter, last: after?.lastChallengeIssuedAt }).toEqual({ wrote: true, session: 's2', counter: 3, last: 1_000 });
  });

  it.each([[1_000], [999]])('refuses a sign-in whose challenge (issued at %d) is not newer than the last, changing nothing', async issuedAt => {
    await authColl.recordSignIn('device', 1_000, { sessionToken: 's2' });
    const wrote = await authColl.recordSignIn('device', issuedAt, { sessionToken: 's-replayed' });
    expect({ wrote, session: (await stored())?.sessionToken, last: (await stored())?.lastChallengeIssuedAt }).toEqual({ wrote: false, session: 's2', last: 1_000 });
  });

  it('records exactly one of two identical sign-ins sent together', async () => {
    const results = await Promise.all([
      authColl.recordSignIn('device', 1_000, { sessionToken: 'first' }),
      authColl.recordSignIn('device', 1_000, { sessionToken: 'second' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it.each([[{ $ne: null }, 1_000], ['device', Number.NaN], ['device', '1000']])('refuses %j at %j, writing nothing', async (requestId, issuedAt) => {
    expect(await authColl.recordSignIn(requestId as never, issuedAt as never, { sessionToken: 'x' })).toBe(false);
    expect((await stored())?.sessionToken).toBe('s1');
  });
});

describe('claimRegistration', () => {
  it('never claims an invite whose device already has a passkey', async () => {
    await authColl.update('device', { registrationToken: 'tok', isEnabled: false });

    expect(await authColl.claimRegistration('tok', { credentialId: 'cred-new', isEnabled: true })).toBeUndefined();
  });
});

describe('recordSignIn and a disabled device', () => {
  it('records nothing for a device disabled after it started signing in', async () => {
    await authColl.update('device', { isEnabled: false });

    expect({ wrote: await authColl.recordSignIn('device', 1_000, { sessionToken: 's2' }), session: (await stored())?.sessionToken }).toEqual({ wrote: false, session: 's1' });
  });
});

// Re-enabling a device clears its old session in ONE conditional write, so an enable that races another cannot clear a
// session the device has just been given (#16 review).
describe('enableIfDisabled', () => {
  it('enables a disabled device and removes its old session token', async () => {
    await authColl.update('device', { isEnabled: false });

    const changed = await authColl.enableIfDisabled('device');
    const after = await stored();

    expect({ changed, isEnabled: after?.isEnabled, hasSession: 'sessionToken' in (after ?? {}) }).toEqual({ changed: true, isEnabled: true, hasSession: false });
  });

  it('leaves an enabled device, and its session, alone', async () => {
    expect({ changed: await authColl.enableIfDisabled('device'), session: (await stored())?.sessionToken }).toEqual({ changed: false, session: 's1' });
  });

  it('clears the old session only once when two enables race, so a session issued in between survives', async () => {
    await authColl.update('device', { isEnabled: false });

    const results = await Promise.all([authColl.enableIfDisabled('device'), authColl.enableIfDisabled('device')]);
    await authColl.update('device', { sessionToken: 'fresh' });
    await authColl.enableIfDisabled('device');

    expect({ changed: results.filter(Boolean).length, session: (await stored())?.sessionToken }).toEqual({ changed: 1, session: 'fresh' });
  });

  it.each([[{ $ne: null }], [''], [1]])('changes nothing for %j, which is not a request id', async requestId => {
    await authColl.update('device', { isEnabled: false });
    expect({ changed: await authColl.enableIfDisabled(requestId as never), isEnabled: (await stored())?.isEnabled }).toEqual({ changed: false, isEnabled: false });
  });
});
