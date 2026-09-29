import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { NexusDeviceDetails, WebAuthnAuthRecord } from '@anupheaus/nexus/common';
import type { ServerDb } from '../providers';
import { WebAuthnAuthCollection } from './WebAuthnAuthCollection';

// `claimRegistration` is the one write that registers a device on an invite. It must be atomic, so of two registrations
// racing on one token only one wins, and it must match ONLY a pending invite (never a device that has registered, however
// it has been disabled since) and, when asked, only one inside the invite lifetime. These run against a real MongoDB,
// because what the filter matches (a missing field against `null`, say) is the behaviour under test.

const NOW = 1_800_000_000_000;
const deviceDetails = { name: 'Pixel 8' } as unknown as NexusDeviceDetails;
const registration: Partial<WebAuthnAuthRecord> = { keyHash: 'hash-new', deviceDetails, sessionToken: 'session-new', isEnabled: true };

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let authColl: WebAuthnAuthCollection;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db('claim_registration');
  authColl = new WebAuthnAuthCollection({ getMongoDb: async () => db } as unknown as ServerDb);
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await db.collection('mxdb_authentication').deleteMany({});
});

/** A pending invite that has been opened, so it holds a registration token. */
async function openedInvite(overrides: Partial<WebAuthnAuthRecord> = {}): Promise<void> {
  await authColl.create({
    requestId: 'r1', userId: 'u1', accountId: 'a1', sessionToken: '', deviceId: '', isEnabled: false,
    createdAt: NOW, registrationToken: 'tok', ...overrides,
  } as WebAuthnAuthRecord);
}

describe('WebAuthnAuthCollection.claimRegistration', () => {
  it('registers the device on the pending invite, removes the token, and returns the invite as it was', async () => {
    await openedInvite();

    const claimed = await authColl.claimRegistration('tok', { ...registration, registrationToken: undefined });
    const stored = await authColl.findById('r1');

    expect({ claimed, stored }).toEqual({
      claimed: expect.objectContaining({ requestId: 'r1', userId: 'u1', accountId: 'a1', isEnabled: false, registrationToken: 'tok' }),
      stored: expect.objectContaining({ requestId: 'r1', keyHash: 'hash-new', deviceDetails, sessionToken: 'session-new', isEnabled: true }),
    });
    expect(stored).not.toHaveProperty('registrationToken');
  });

  it('removes the token even when the patch does not mention it', async () => {
    await openedInvite();

    await authColl.claimRegistration('tok', registration);

    expect(await authColl.findByRegistrationToken('tok')).toBeUndefined();
  });

  it('lets only one of two registrations racing on the same token win', async () => {
    await openedInvite();

    const results = await Promise.all([
      authColl.claimRegistration('tok', { ...registration, keyHash: 'hash-a' }),
      authColl.claimRegistration('tok', { ...registration, keyHash: 'hash-b' }),
    ]);
    const winners = results.filter(result => result != null).length;
    const stored = await authColl.findById('r1');

    expect({ winners, keyHashes: [await authColl.findByKeyHash('hash-a'), await authColl.findByKeyHash('hash-b')].filter(found => found != null).length })
      .toEqual({ winners: 1, keyHashes: 1 });
    expect(stored?.keyHash).toMatch(/^hash-[ab]$/);
  });

  it.each([
    ['enabled', { isEnabled: true }],
    ['signed out (disabled, keeping its key hash and device details)', { keyHash: 'hash-old', deviceDetails }],
    ['disabled by an admin (only its key hash left)', { keyHash: 'hash-old' }],
    ['one that has connected', { lastConnectedAt: NOW }],
  ])('claims nothing, and changes nothing, on a device that is %s', async (_label, state) => {
    await openedInvite(state as Partial<WebAuthnAuthRecord>);
    const before = await authColl.findById('r1');

    const claimed = await authColl.claimRegistration('tok', registration);

    expect({ claimed, after: await authColl.findById('r1') }).toEqual({ claimed: undefined, after: before });
  });

  it('claims nothing for a token no invite holds', async () => {
    await openedInvite();

    expect(await authColl.claimRegistration('other', registration)).toBeUndefined();
  });

  it('with createdSince, claims an invite created at or after it', async () => {
    await openedInvite({ createdAt: NOW });

    expect((await authColl.claimRegistration('tok', registration, { createdSince: NOW }))?.requestId).toBe('r1');
  });

  it.each([
    ['created before it', { createdAt: NOW - 1 }],
    ['with no creation time (it cannot be dated, so it fails closed)', { createdAt: undefined }],
  ])('with createdSince, claims nothing, and changes nothing, on an invite %s', async (_label, dated) => {
    await openedInvite(dated);
    const before = await authColl.findById('r1');

    const claimed = await authColl.claimRegistration('tok', registration, { createdSince: NOW });

    expect({ claimed, after: await authColl.findById('r1') }).toEqual({ claimed: undefined, after: before });
  });
});
