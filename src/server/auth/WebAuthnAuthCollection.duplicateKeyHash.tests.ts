import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { WebAuthnAuthRecord } from '@anupheaus/nexus/common';
import type { ServerDb } from '../providers';
import { WebAuthnAuthCollection } from './WebAuthnAuthCollection';

// One key hash, one device: a unique index enforces it (sc-613). When a write breaks it (two registrations racing past
// nexus's own check), the caller must get nexus's plain "Passkey already registered", never MongoDB's duplicate-key
// error, which names the index and repeats the stored digest to the client and the logs.

const DIGEST = `sha256:${'a'.repeat(64)}`;

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
  db = client.db(`duplicate_key_hash_${++dbCount}`);
  authColl = new WebAuthnAuthCollection({ getMongoDb: async () => db } as unknown as ServerDb);
  await authColl.create({ requestId: 'holder', userId: 'u1', deviceId: 'd1', sessionToken: 's1', isEnabled: true, keyHash: DIGEST } as WebAuthnAuthRecord);
});

/** The error a write throws, or 'written'. */
const outcome = (write: Promise<unknown>) => write.then(() => 'written', (error: Error) => error);

describe('a key hash another device holds', () => {
  it('refuses a new record with it, in plain words that name neither the index nor the digest', async () => {
    const error = await outcome(authColl.create({ requestId: 'copy', userId: 'u2', deviceId: 'd2', sessionToken: 's2', isEnabled: true, keyHash: DIGEST } as WebAuthnAuthRecord));

    expect(error).toBeInstanceOf(Error);
    expect({ message: (error as Error).message, leaks: /keyHash_1|E11000|sha256:/.test((error as Error).message) }).toEqual({ message: 'Passkey already registered', leaks: false });
  });

  it('refuses a registration claim that would set it, leaving the invite pending', async () => {
    await authColl.create({ requestId: 'invite', userId: 'u2', deviceId: '', sessionToken: '', isEnabled: false, registrationToken: 'tok', createdAt: Date.now() } as WebAuthnAuthRecord);

    const error = await outcome(authColl.claimRegistration('tok', { keyHash: DIGEST, isEnabled: true, sessionToken: 's2' }));

    expect({ message: (error as Error).message, invite: (await authColl.findById('invite'))?.isEnabled }).toEqual({ message: 'Passkey already registered', invite: false });
  });

  it('refuses an update that would set it', async () => {
    await authColl.create({ requestId: 'other', userId: 'u2', deviceId: 'd2', sessionToken: 's2', isEnabled: true, keyHash: `sha256:${'b'.repeat(64)}` } as WebAuthnAuthRecord);

    const error = await outcome(authColl.update('other', { keyHash: DIGEST }));

    expect((error as Error).message).toBe('Passkey already registered');
  });

  it('still lets a record with no key hash, or another key hash, be written', async () => {
    const results = [
      await outcome(authColl.create({ requestId: 'invite-a', userId: 'u2', deviceId: '', sessionToken: '', isEnabled: false } as WebAuthnAuthRecord)),
      await outcome(authColl.create({ requestId: 'invite-b', userId: 'u2', deviceId: '', sessionToken: '', isEnabled: false } as WebAuthnAuthRecord)),
      await outcome(authColl.create({ requestId: 'other', userId: 'u3', deviceId: 'd3', sessionToken: 's3', isEnabled: true, keyHash: `sha256:${'c'.repeat(64)}` } as WebAuthnAuthRecord)),
    ];
    expect(results).toEqual(['written', 'written', 'written']);
  });

  it('passes any other write error through unchanged', async () => {
    const error = await outcome(authColl.create({ requestId: 'holder', userId: 'u9', deviceId: 'd9', sessionToken: 's9', isEnabled: true } as WebAuthnAuthRecord));

    expect({ isDuplicateId: /E11000/.test((error as Error).message), mapped: (error as Error).message === 'Passkey already registered' }).toEqual({ isDuplicateId: true, mapped: false });
  });
});
