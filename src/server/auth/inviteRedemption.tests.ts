import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { NexusDeviceDetails } from '@anupheaus/nexus/common';
import { Logger } from '@anupheaus/common';
import { createSoftwarePasskey } from './softwarePasskey.testing';
import { startServer } from '../startServer';
import type { ServerInstance } from '../internalModels';

// Invite redemption end to end: a real mxdb server with an invite lifetime, nexus's own invite / register / re-auth /
// sign-out REST routes, and a real MongoDB. The stores and handlers are tested on their own elsewhere; this proves they
// hold together as a deployment runs them.

const NAME = 'redeem';
const TTL_MS = 24 * 60 * 60 * 1000;
const DB_NAME = 'invite_redemption';
const deviceDetails = {
  userAgent: 'vitest', platform: 'test', language: 'en-GB', screenWidth: 1080, screenHeight: 2400,
  viewportWidth: 412, viewportHeight: 915, colorDepth: 24, pixelRatio: 2.6, timezone: 'Europe/London',
} as unknown as NexusDeviceDetails;

let replSet: MongoMemoryReplSet;
let mongo: MongoClient;
let db: Db;
let httpServer: http.Server;
let instance: ServerInstance;
let baseUrl: string;
/** The unit setup installs browser globals for every file; this one runs only server code, which refuses a browser. */
let browserWindow: unknown;

beforeAll(async () => {
  browserWindow = globalThis.window;
  (globalThis as { window?: unknown; }).window = undefined;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  mongo = await MongoClient.connect(replSet.getUri());
  db = mongo.db(DB_NAME);
  httpServer = http.createServer();
  instance = await startServer({
    name: NAME,
    logger: new Logger('invite-redemption-test'),
    collections: [],
    server: httpServer,
    mongoDbName: DB_NAME,
    mongoDbUrl: replSet.getUri(),
    auth: {
      mode: 'webauthn', inviteTtlMs: TTL_MS, onGetInviteDetails: async () => ({ appName: 'Redemption test' }) as never,
      rpIds: [RP_ID], isAllowedOrigin: origin => origin === ORIGIN, challengeSecret: 'redemption-test-secret',
    },
  });
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await instance?.close();
  await new Promise(resolve => httpServer?.close(resolve));
  await mongo?.close();
  await replSet?.stop();
  (globalThis as { window?: unknown; }).window = browserWindow;
});

interface Reply { status: number; body: Record<string, unknown>; sessionToken?: string; }

async function call(method: 'GET' | 'POST', path: string, body?: object, sessionToken?: string): Promise<Reply> {
  const response = await fetch(`${baseUrl}/${NAME}/socketAPI/${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(sessionToken != null ? { cookie: `nexus_session=${sessionToken}` } : {}) },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const cookie = response.headers.get('set-cookie')?.match(/nexus_session=([^;]+)/)?.[1];
  return { status: response.status, body: text === '' ? {} : JSON.parse(text), sessionToken: cookie };
}

const RP_ID = 'app.test';
const ORIGIN = 'https://app.test';
/** One software passkey per test key, so a device signs in with the passkey it registered. */
const passkeys = new Map<string, ReturnType<typeof createSoftwarePasskey>>();
const passkeyFor = (key: string) => {
  if (!passkeys.has(key)) passkeys.set(key, createSoftwarePasskey({ rpId: RP_ID, origin: ORIGIN }));
  return passkeys.get(key)!;
};
/** The app installation the passkey named `key` lives on (sc-645): every real client sends its own with each request. */
const installationFor = (key: string) => `installation-${key}`;
const openInvite = (requestId: string) => call('GET', `webauthn/invite?requestId=${encodeURIComponent(requestId)}`);
/** Registers the passkey named `key` with the invite's registration token (sc-627: the server verifies it). */
const register = (registrationToken: string, key: string) =>
  call('POST', 'webauthn/register', { registrationToken, credential: passkeyFor(key).register(new TextEncoder().encode(registrationToken)), deviceDetails, installationId: installationFor(key) });
/** Signs in with the passkey named `key`, from the installation it registered on, by signing a fresh challenge from the server. */
const reauth = async (key: string) => {
  const { challenge } = (await call('GET', 'webauthn/challenge')).body as { challenge: string; };
  return call('POST', 'webauthn/reauth', { credential: passkeyFor(key).signIn(challenge), deviceDetails, installationId: installationFor(key) });
};
const signOut = (sessionToken: string) => call('POST', 'signout', {}, sessionToken);
/** 'accepted', or the refusal's message. (nexus answers a refused redemption with a plain error, so the status says little.) */
const outcome = (reply: Reply) => reply.status < 300 ? 'accepted' : (reply.body.error as { message?: string; } | undefined)?.message;

/** Issues an invite the way an app does, returning its request id (the `?requestId=` in the emailed link). */
async function invite(userId: string): Promise<string> {
  const url = await instance.createInvite!({ userId, baseUrl: 'https://app.test/' });
  return new URL(url).searchParams.get('requestId')!;
}

async function stored(requestId: string) {
  return db.collection('mxdb_authentication').findOne({ _id: requestId as never });
}

/** Moves an invite's creation time back, as if it was issued `ageMs` ago. */
async function age(requestId: string, ageMs: number): Promise<void> {
  await db.collection('mxdb_authentication').updateOne({ _id: requestId as never }, { $set: { createdAt: Date.now() - ageMs } });
}

describe('invite redemption through nexus, with an invite lifetime', () => {
  it('registers a device from a fresh invite, and the device can then re-authenticate', async () => {
    const requestId = await invite('u-fresh');

    const opened = await openInvite(requestId);
    const registered = await register(String(opened.body.registrationToken), 'hash-fresh');
    const reauthed = await reauth('hash-fresh');

    expect({
      opened: outcome(opened),
      registered: [registered.status, registered.body.userId, registered.sessionToken != null],
      reauthed: [reauthed.status, reauthed.body.userId],
    }).toEqual({ opened: 'accepted', registered: [200, 'u-fresh', true], reauthed: [200, 'u-fresh'] });
  });

  it('refuses a registration finished after the lifetime, even though the link was opened inside it, and changes nothing', async () => {
    const requestId = await invite('u-late');
    const opened = await openInvite(requestId);
    await age(requestId, TTL_MS + 60_000);

    const registered = await register(String(opened.body.registrationToken), 'hash-late');
    const after = await stored(requestId);

    expect({
      opened: outcome(opened),
      registered: [outcome(registered), registered.sessionToken],
      after: { isEnabled: after?.isEnabled, credentialId: after?.credentialId },
    }).toEqual({
      opened: 'accepted',
      registered: ['Invalid registration token', undefined],
      after: { isEnabled: false, credentialId: undefined },
    });
  });

  it('refuses to open an invite older than the lifetime', async () => {
    const requestId = await invite('u-old');
    await age(requestId, TTL_MS + 60_000);

    const opened = await openInvite(requestId);

    expect(outcome(opened)).toBe('Invite not found');
  });

  it('refuses the old link of a device that has signed out, so nobody can register over it', async () => {
    const requestId = await invite('u-signed-out');
    const opened = await openInvite(requestId);
    const registered = await register(String(opened.body.registrationToken), 'hash-signed-out');
    const signedOut = await signOut(registered.sessionToken!);

    const reopened = await openInvite(requestId);
    const after = await stored(requestId);

    expect({
      signedOut: signedOut.status,
      reopened: outcome(reopened),
      after: { isEnabled: after?.isEnabled, credentialId: after?.credentialId, registrationToken: after?.registrationToken },
    }).toEqual({
      signedOut: 200,
      reopened: 'Invite not found',
      after: { isEnabled: false, credentialId: passkeyFor('hash-signed-out').credentialId, registrationToken: undefined },
    });
  });

  it('refuses the link of a device an admin has disabled', async () => {
    const requestId = await invite('u-disabled');
    const opened = await openInvite(requestId);
    await register(String(opened.body.registrationToken), 'hash-disabled');
    await instance.disableDevice(requestId);

    const reopened = await openInvite(requestId);

    expect(outcome(reopened)).toBe('Invite not found');
  });

  it('still re-authenticates a registered device long after its invite would have expired', async () => {
    const requestId = await invite('u-veteran');
    const opened = await openInvite(requestId);
    await register(String(opened.body.registrationToken), 'hash-veteran');
    await age(requestId, 30 * TTL_MS);

    const reauthed = await reauth('hash-veteran');

    expect([reauthed.status, reauthed.body.userId, reauthed.sessionToken != null]).toEqual([200, 'u-veteran', true]);
  });

  // sc-620: nexus hands parsed JSON to these handlers, so a key can arrive as a MongoDB operator. The store must match
  // nothing for it, or `{ "$ne": null }` signs the caller in as the first registered device.
  it.each([
    ['{ $ne: null }', { $ne: null }],
    ['{ $gt: "" }', { $gt: '' }],
    ['{ $exists: true }', { $exists: true }],
  ])('refuses %s in place of a credential id, registration token or invite id, issuing no session', async (_label, operator) => {
    // Only these records, so the operator's first match is an enabled device: the one it would sign the caller in as.
    await db.collection('mxdb_authentication').deleteMany({});
    const requestId = await invite('u-target');
    const opened = await openInvite(requestId);
    await register(String(opened.body.registrationToken), 'hash-target');
    const pendingId = await invite('u-pending');
    await openInvite(pendingId);

    const replies = [
      // With a valid installation id, so each refusal is the operator's, not a missing installation id's (sc-645).
      await call('POST', 'webauthn/reauth', { credential: { id: operator, rawId: 'x', type: 'public-key', response: {} }, deviceDetails, installationId: installationFor('attacker') }),
      await call('POST', 'webauthn/register', { registrationToken: operator, credential: passkeyFor('attacker').register(new TextEncoder().encode('x')), deviceDetails, installationId: installationFor('attacker') }),
      await call('GET', 'webauthn/invite?requestId[$ne]=x'),
    ];
    const pending = await stored(pendingId);

    expect({
      outcomes: replies.map(reply => reply.status < 300),
      sessions: replies.filter(reply => reply.sessionToken != null).length,
      pendingStillPending: [pending?.isEnabled, pending?.credentialId],
      attackerRegistered: await db.collection('mxdb_authentication').countDocuments({ credentialId: passkeyFor('attacker').credentialId }),
    }).toEqual({ outcomes: [false, false, false], sessions: 0, pendingStillPending: [false, undefined], attackerRegistered: 0 });
  });

  // Two requests sent together: exactly one device registers. (Over HTTP they may not interleave, so the atomic claim
  // itself is proven in WebAuthnAuthCollection.claimRegistration.tests.ts, where the two writes race on MongoDB.)
  it('registers exactly one device when two registrations are sent together with one token', async () => {
    const requestId = await invite('u-race');
    const opened = await openInvite(requestId);
    const token = String(opened.body.registrationToken);

    const replies = await Promise.all([register(token, 'hash-race-a'), register(token, 'hash-race-b')]);
    const after = await stored(requestId);

    expect({
      outcomes: replies.map(outcome).sort(),
      cookies: replies.filter(reply => reply.sessionToken != null).length,
      stored: after?.credentialId === passkeyFor(outcome(replies[0]) === 'accepted' ? 'hash-race-a' : 'hash-race-b').credentialId,
    }).toEqual({ outcomes: ['Invalid registration token', 'accepted'], cookies: 1, stored: true });
  });
});
