import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Collection, MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { WebAuthnAuthRecord } from '@anupheaus/nexus/common';
import type { ServerDb } from '../providers';
import { WebAuthnAuthCollection } from './WebAuthnAuthCollection';
import { PASSKEYS_COLLECTION } from './passkeyState';

// sc-645 (QA round 1): a synced passkey's devices share one key, so what guards the passkey holds for the passkey, in one
// atomic write each, against a real MongoDB because the filters and the races are the behaviour under test:
// (1) a signed sign-in is claimed once across all the passkey's devices; (2) so one sign-in creates at most one device,
// whatever installation ids it is sent with; (3) disabling or deleting any device revokes the passkey, and the revoke
// outlives the device.

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let authColl: WebAuthnAuthCollection;
let dbCount = 0;

const device = (requestId: string, installationId: string, overrides: Partial<WebAuthnAuthRecord> = {}): WebAuthnAuthRecord => ({
  requestId, userId: 'u1', deviceId: requestId, sessionToken: `s-${requestId}`, isEnabled: true,
  credentialId: 'cred-1', credentialPublicKey: 'pk-1', credentialCounter: 0, installationId, ...overrides,
});
const claim = (challenge: string, isNewDevice = false, credentialId = 'cred-1') => authColl.claimPasskeySignIn({ credentialId, challenge, challengeIssuedAt: 1_000, isNewDevice });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  db = client.db(`passkey_state_${++dbCount}`);
  authColl = new WebAuthnAuthCollection({ getMongoDb: async () => db } as unknown as ServerDb);
  await authColl.create(device('phone', 'phone'));
  await authColl.create(device('laptop', 'laptop'));
});

describe('claimPasskeySignIn: a signed sign-in is single-use across the passkey', () => {
  it('claims a sign-in once, and refuses the same challenge again whichever device sends it', async () => {
    expect([await claim('challenge-1'), await claim('challenge-1'), await claim('challenge-1', true)]).toEqual([true, false, false]);
  });

  it('claims different sign-ins of the same passkey, so siblings signing in at once both succeed', async () => {
    expect(await Promise.all([claim('phone-challenge'), claim('laptop-challenge')])).toEqual([true, true]);
  });

  it('keeps passkeys apart: one passkey\'s claim does not refuse another\'s', async () => {
    expect([await claim('challenge-1'), await claim('challenge-1', false, 'cred-2')]).toEqual([true, true]);
  });

  it('lets exactly one of the same sign-in sent at once as three new devices through', async () => {
    const results = await Promise.all([claim('challenge-1', true), claim('challenge-1', true), claim('challenge-1', true)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('lets exactly one through when the passkey has never claimed before (the racing first writes)', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => claim('first-ever', true, 'cred-new')));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('claims every different first-ever sign-in that races, retrying the one that lost the insert', async () => {
    expect(await Promise.all(['a', 'b', 'c'].map(challenge => claim(challenge, false, 'cred-new')))).toEqual([true, true, true]);
  });

  it('keeps no more than the newest 100 claimed sign-ins of a passkey', async () => {
    for (let issuedAt = 0; issuedAt < 105; issuedAt++) await authColl.claimPasskeySignIn({ credentialId: 'cred-1', challenge: `c-${issuedAt}`, challengeIssuedAt: issuedAt, isNewDevice: false });
    const { signIns } = await db.collection(PASSKEYS_COLLECTION).findOne({ _id: 'cred-1' as never }) as unknown as { signIns: { challenge: string }[] };
    expect({ count: signIns.length, oldest: signIns[0]?.challenge }).toEqual({ count: 100, oldest: 'c-5' });
  });

  it.each([
    ['an operator as the credential id', { credentialId: { $ne: null }, challenge: 'c', challengeIssuedAt: 1, isNewDevice: false }],
    ['an operator as the challenge', { credentialId: 'cred-1', challenge: { $ne: null }, challengeIssuedAt: 1, isNewDevice: false }],
    ['a challenge time that is not a number', { credentialId: 'cred-1', challenge: 'c', challengeIssuedAt: '1', isNewDevice: false }],
  ])('refuses %s, writing nothing', async (_label, badClaim) => {
    expect({ claimed: await authColl.claimPasskeySignIn(badClaim as never), passkeys: await db.collection(PASSKEYS_COLLECTION).countDocuments() }).toEqual({ claimed: false, passkeys: 0 });
  });
});

describe('a revoke is recorded for the passkey and outlives the device', () => {
  it('revokes the passkey when one of its devices is disabled (an admin, or nexus\'s sign-out)', async () => {
    await authColl.update('phone', { isEnabled: false });
    expect(await authColl.isPasskeyRevoked('cred-1')).toBe(true);
  });

  it('keeps the revoke after the disabled device is deleted, while a sibling remains', async () => {
    await authColl.update('phone', { isEnabled: false });
    await authColl.delete('phone');

    expect({ revoked: await authColl.isPasskeyRevoked('cred-1'), newDevice: await claim('challenge-1', true), devices: (await authColl.findAllByCredentialId('cred-1')).length })
      .toEqual({ revoked: true, newDevice: false, devices: 1 });
  });

  it('revokes the passkey when an enabled device is deleted', async () => {
    await authColl.delete('laptop');
    expect(await authColl.isPasskeyRevoked('cred-1')).toBe(true);
  });

  it('keeps the revoke when the disabled device is re-enabled', async () => {
    await authColl.update('phone', { isEnabled: false });
    await authColl.enableIfDisabled('phone');
    await authColl.update('phone', { isEnabled: true });
    expect(await authColl.isPasskeyRevoked('cred-1')).toBe(true);
  });

  it('still lets a revoked passkey\'s enabled devices sign in: it only stops new devices', async () => {
    await authColl.update('phone', { isEnabled: false });
    expect([await claim('laptop-challenge'), await claim('new-device-challenge', true)]).toEqual([true, false]);
  });

  it('revokes nothing for a device without a passkey (a pending invite), or for other writes', async () => {
    await authColl.create({ requestId: 'invite', userId: 'u1', deviceId: '', sessionToken: '', isEnabled: false } as WebAuthnAuthRecord);
    await authColl.update('invite', { isEnabled: false });
    await authColl.delete('invite');
    await authColl.update('phone', { lastConnectedAt: 5 });

    expect({ revoked: await authColl.isPasskeyRevoked('cred-1'), passkeys: await db.collection(PASSKEYS_COLLECTION).countDocuments() }).toEqual({ revoked: false, passkeys: 0 });
  });

  it('records the revoke before the device write, so a revoke is never lost to a failed delete', async () => {
    // The device delete itself fails, after the revoke: the passkey must already be revoked.
    const failedDelete = vi.spyOn(Collection.prototype, 'deleteOne').mockRejectedValueOnce(new Error('connection lost'));

    await expect(authColl.delete('phone')).rejects.toThrow('connection lost');
    failedDelete.mockRestore();
    expect({ revoked: await authColl.isPasskeyRevoked('cred-1'), phone: (await authColl.findById('phone'))?.requestId }).toEqual({ revoked: true, phone: 'phone' });
  });

  it('revokes, on first opening an existing collection, the passkeys of devices disabled before revokes were recorded', async () => {
    const earlier = client.db(`passkey_state_earlier_${dbCount}`);
    await earlier.collection('mxdb_authentication').insertMany([
      { _id: 'old-disabled' as never, userId: 'u1', credentialId: 'cred-old', isEnabled: false },
      { _id: 'old-enabled' as never, userId: 'u1', credentialId: 'cred-live', isEnabled: true },
    ]);
    const upgraded = new WebAuthnAuthCollection({ getMongoDb: async () => earlier } as unknown as ServerDb);
    await upgraded.findById('x');

    expect([await upgraded.isPasskeyRevoked('cred-old'), await upgraded.isPasskeyRevoked('cred-live')]).toEqual([true, false]);
  });
});
