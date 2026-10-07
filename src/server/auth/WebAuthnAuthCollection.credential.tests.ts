import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { WebAuthnAuthRecord } from '@anupheaus/nexus/common';
import type { ServerDb } from '../providers';
import { WebAuthnAuthCollection } from './WebAuthnAuthCollection';

// sc-627: a device signs in by its passkey's signature, found by the passkey's credential id. The store finds devices by
// credential id, keeps one device per installation of a credential (sc-645), records a sign-in only if its challenge is newer than the device's last
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

// sc-645: a synced passkey signs in on several installations, and each installation is its own device.
describe('one device per installation of a passkey', () => {
  const installation = (requestId: string, installationId?: string) => ({
    requestId, userId: 'u1', deviceId: requestId, sessionToken: requestId, isEnabled: true, credentialId: 'cred-1', credentialPublicKey: 'pk-1', installationId,
  } as WebAuthnAuthRecord);

  it('refuses a second device with the same credential id on the same installation, in plain words', async () => {
    await authColl.update('device', { installationId: 'phone' });
    expect(await outcome(authColl.create(installation('copy', 'phone')))).toBe('Passkey already registered');
  });

  it('refuses a second device with the same credential id when neither has an installation id, as before installations', async () => {
    expect(await outcome(authColl.create(installation('copy')))).toBe('Passkey already registered');
  });

  it('holds one device for each installation of the same passkey, and finds them all', async () => {
    await authColl.update('device', { installationId: 'phone' });

    const created = await outcome(authColl.create(installation('laptop', 'laptop')));
    const devices = await authColl.findAllByCredentialId('cred-1');

    expect({ created, devices: devices.map(({ requestId, installationId }) => ({ requestId, installationId })).sort((a, b) => a.requestId.localeCompare(b.requestId)) })
      .toEqual({ created: undefined, devices: [{ requestId: 'device', installationId: 'phone' }, { requestId: 'laptop', installationId: 'laptop' }] });
  });

  it('registers one of two identical new installations created together', async () => {
    const results = await Promise.all([outcome(authColl.create(installation('first', 'laptop'))), outcome(authColl.create(installation('second', 'laptop')))]);
    expect(results.filter(result => result === undefined)).toHaveLength(1);
  });

  it('still allows any number of pending invites, which have no credential', async () => {
    const invite = (id: string) => authColl.create({ requestId: id, userId: 'u3', deviceId: '', sessionToken: '', isEnabled: false } as WebAuthnAuthRecord);
    expect([await outcome(invite('i1')), await outcome(invite('i2'))]).toEqual([undefined, undefined]);
  });

  it('gives an existing collection the unique installation index when it is first opened, and drops sc-627\'s one-device index', async () => {
    const earlier = client.db(`credential_earlier_${dbCount}`);
    await earlier.collection('mxdb_authentication').createIndex({ credentialId: 1 }, { name: 'credentialId_1', unique: true, partialFilterExpression: { credentialId: { $type: 'string' } } });
    await earlier.collection('mxdb_authentication').insertOne({ _id: 'old' as never, userId: 'u1', credentialId: 'cred-1', isEnabled: true });
    await new WebAuthnAuthCollection({ getMongoDb: async () => earlier } as unknown as ServerDb).findById('x');

    const indexes = await earlier.collection('mxdb_authentication').indexes();
    const index = indexes.find(({ name }) => name === 'credentialId_1_installationId_1');
    expect({
      unique: index?.unique, keys: index?.key, partial: index?.partialFilterExpression,
      hasOldIndex: indexes.some(({ name }) => name === 'credentialId_1'),
    }).toEqual({ unique: true, keys: { credentialId: 1, installationId: 1 }, partial: { credentialId: { $type: 'string' } }, hasOldIndex: false });
  });
});

describe('findAllByCredentialId', () => {
  it('finds nothing for a passkey no device has', async () => {
    expect(await authColl.findAllByCredentialId('cred-unknown')).toEqual([]);
  });

  it.each([[{ $ne: null }], [{ $gt: '' }], [['cred-1']], [1], [''], [null]])('finds nothing for %j, which is not a credential id', async id => {
    expect(await authColl.findAllByCredentialId(id as never)).toEqual([]);
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
