import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import '@anupheaus/common';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { isPendingWebAuthnInvite, type NexusDeviceDetails, type WebAuthnAuthRecord } from '@anupheaus/nexus/common';
import type { ServerDb } from '../providers';
import { WebAuthnAuthCollection } from './WebAuthnAuthCollection';
import { deletePendingInvite, expireStalePendingInvites, getDevices } from './deviceManagement';

// Whether a record is still a pending invite is a security rule: an invite link must never work again once its device has
// registered. nexus's `isPendingWebAuthnInvite` is the one definition, and every MongoDB query mxdb makes for pending
// invites (the stale finder, the expiry sweep, the conditional delete) must match exactly the records it accepts. These
// run against a real MongoDB, because what a filter matches (a missing field against `null`, say) is the behaviour under test.

const CREATED_AT = 1_000;
const STALE_BEFORE = 2_000;
const deviceDetails = { name: 'Pixel 8' } as unknown as NexusDeviceDetails;

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let authColl: WebAuthnAuthCollection;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db('pending_invites');
  authColl = new WebAuthnAuthCollection({ getMongoDb: async () => db } as unknown as ServerDb);
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await db.collection('mxdb_authentication').deleteMany({});
});

interface RecordShape {
  name: string;
  fields: Partial<WebAuthnAuthRecord>;
}

/** Every way a record can look, from a fresh invite to a registered device in each state. */
const SHAPES: RecordShape[] = [
  { name: 'fresh invite', fields: { isEnabled: false } },
  { name: 'invite with isEnabled missing', fields: {} },
  { name: 'invite with null device fields', fields: { isEnabled: false, keyHash: null, credentialId: null, deviceDetails: null, lastConnectedAt: null } as unknown as Partial<WebAuthnAuthRecord> },
  { name: 'enabled, nothing else', fields: { isEnabled: true } },
  { name: 'key hash only', fields: { isEnabled: false, keyHash: 'hash-only' } },
  { name: 'credential only', fields: { isEnabled: false, credentialId: 'cred-only' } },
  { name: 'device details only', fields: { isEnabled: false, deviceDetails } },
  { name: 'connected only', fields: { isEnabled: false, lastConnectedAt: 1_500 } },
  { name: 'registered and enabled', fields: { isEnabled: true, keyHash: 'hash-active', deviceDetails, lastConnectedAt: 1_500 } },
  { name: 'registered and disabled', fields: { isEnabled: false, keyHash: 'hash-disabled', credentialId: 'cred-disabled', deviceDetails } },
];

async function createRecord(requestId: string, fields: Partial<WebAuthnAuthRecord>): Promise<void> {
  const { isEnabled, ...rest } = fields;
  const record = { requestId, userId: 'u1', sessionToken: '', deviceId: '', createdAt: CREATED_AT, ...rest } as WebAuthnAuthRecord;
  // `create` takes the record as a whole; a missing `isEnabled` is a shape under test, so it is left off rather than defaulted.
  await authColl.create((isEnabled == null ? record : { ...record, isEnabled }) as WebAuthnAuthRecord);
}

async function createEveryShape(): Promise<void> {
  await SHAPES.mapAsync(async ({ name, fields }) => createRecord(name, fields));
}

const pendingShapeNames = SHAPES.filter(({ fields }) => isPendingWebAuthnInvite(fields as WebAuthnAuthRecord)).map(({ name }) => name).sort();

describe('pending invites share nexus\'s definition', () => {
  it('the shapes cover both pending and registered records', () => {
    expect(pendingShapeNames).toEqual(['fresh invite', 'invite with isEnabled missing', 'invite with null device fields']);
  });

  it('findStalePendingInvites finds exactly the records isPendingWebAuthnInvite accepts', async () => {
    await createEveryShape();
    const found = await authColl.findStalePendingInvites(STALE_BEFORE);
    expect(found.map(({ requestId }) => requestId).sort()).toEqual(pendingShapeNames);
  });

  it('expireStalePendingInvites deletes exactly those records and leaves every registered device', async () => {
    await createEveryShape();
    const removed = await expireStalePendingInvites(authColl, Date.now() - STALE_BEFORE);
    const left = await db.collection('mxdb_authentication').find({}).toArray();
    expect({ removed, left: left.map(({ _id }) => _id).sort() }).toEqual({
      removed: pendingShapeNames.length,
      left: SHAPES.map(({ name }) => name).filter(name => !pendingShapeNames.includes(name)).sort(),
    });
  });

  it('expireStalePendingInvites leaves a pending invite that is still inside its lifetime', async () => {
    await createRecord('young', { isEnabled: false, createdAt: Date.now() });
    expect(await expireStalePendingInvites(authColl, 60_000)).toBe(0);
    expect(await authColl.findById('young')).toBeDefined();
  });

  it('getDevices gives each record its status', async () => {
    await createEveryShape();
    const devices = await getDevices(authColl, 'u1');
    const statuses = Object.fromEntries(devices.map(({ requestId, status }) => [requestId, status]));
    expect(statuses).toEqual({
      'fresh invite': 'pending',
      'invite with isEnabled missing': 'pending',
      'invite with null device fields': 'pending',
      'enabled, nothing else': 'active',
      'key hash only': 'disabled',
      'credential only': 'disabled',
      'device details only': 'disabled',
      'connected only': 'disabled',
      'registered and enabled': 'active',
      'registered and disabled': 'disabled',
    });
  });
});

describe('deletePendingInvite', () => {
  it('deletes a pending invite and resolves true', async () => {
    await createRecord('invite', { isEnabled: false });
    expect(await deletePendingInvite(authColl, 'invite')).toBe(true);
    expect(await authColl.findById('invite')).toBeUndefined();
  });

  it('is a no-op for an invite that registered after it was listed', async () => {
    await createRecord('invite', { isEnabled: false });
    const [listed] = await getDevices(authColl, 'u1');
    expect(listed?.status).toBe('pending');

    // The device registers between the listing and the delete.
    await authColl.update('invite', { isEnabled: true, keyHash: 'hash-registered', deviceDetails });

    expect(await deletePendingInvite(authColl, 'invite')).toBe(false);
    expect(await authColl.findById('invite')).toEqual(expect.objectContaining({ requestId: 'invite', isEnabled: true }));
  });

  it.each(SHAPES.filter(({ name }) => !pendingShapeNames.includes(name)))('leaves a registered record alone: $name', async ({ name, fields }) => {
    await createRecord(name, fields);
    expect(await deletePendingInvite(authColl, name)).toBe(false);
    expect(await authColl.findById(name)).toBeDefined();
  });

  it('deletes nothing for a key that is not a non-empty string', async () => {
    await createRecord('invite', { isEnabled: false });
    expect(await deletePendingInvite(authColl, { $ne: null } as unknown as string)).toBe(false);
    expect(await deletePendingInvite(authColl, '')).toBe(false);
    expect(await authColl.findById('invite')).toBeDefined();
  });
});
