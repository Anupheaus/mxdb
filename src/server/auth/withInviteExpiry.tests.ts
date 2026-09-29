import { describe, expect, it } from 'vitest';
import type { WebAuthnAuthRecord, WebAuthnAuthStore } from '@anupheaus/nexus/common';
import { withInviteExpiry } from './withInviteExpiry';

// An invite link must stop working once it is older than the invite lifetime, even before the nightly sweep deletes
// it: nexus redeems through `findById` (opening the link) and `findByRegistrationToken` (finishing registration), so an
// expired pending invite must look absent to both. Registered devices, and every other lookup, are untouched.

const TTL_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function record(overrides: Partial<WebAuthnAuthRecord>): WebAuthnAuthRecord {
  return { requestId: 'r1', sessionToken: '', userId: 'u1', deviceId: '', isEnabled: false, createdAt: NOW - 1_000, ...overrides };
}

/** An in-memory store holding one record, found by id, registration token, session token or key hash alike. */
function storeWith(held: WebAuthnAuthRecord) {
  const calls: string[] = [];
  const store: WebAuthnAuthStore & { findByUserId(userId: string): Promise<WebAuthnAuthRecord[]>; } = {
    create: async () => undefined,
    update: async () => undefined,
    findById: async () => held,
    findByRegistrationToken: async () => held,
    findBySessionToken: async () => held,
    findByDevice: async () => held,
    findByKeyHash: async () => held,
    // Proves unfiltered methods still run against the store itself (`this`).
    async findByUserId(this: unknown) { calls.push(this === store ? 'bound' : 'unbound'); return [held]; },
  } as never;
  return { store: withInviteExpiry(store, TTL_MS, () => NOW), calls };
}

describe('withInviteExpiry', () => {
  it('redeems a pending invite younger than the lifetime', async () => {
    const { store } = storeWith(record({ createdAt: NOW - TTL_MS + 1 }));

    expect([await store.findById('r1'), await store.findByRegistrationToken('t')].map(found => found?.requestId)).toEqual(['r1', 'r1']);
  });

  it.each([
    ['older than the lifetime', NOW - TTL_MS - 1],
    ['with no creation time (cannot be dated, so fails closed)', undefined],
  ])('treats a pending invite %s as not found, when opened and when registering', async (_label, createdAt) => {
    const { store } = storeWith(record({ createdAt }));

    expect([await store.findById('r1'), await store.findByRegistrationToken('t')]).toEqual([undefined, undefined]);
  });

  it('never hides a registered device, however old', async () => {
    const registered = record({ isEnabled: true, createdAt: NOW - 30 * TTL_MS, deviceDetails: { name: 'Pixel' } as never });
    const { store } = storeWith(registered);

    expect(await store.findById('r1')).toEqual(registered);
  });

  it('leaves every other lookup alone, and still runs it against the store', async () => {
    const expired = record({ createdAt: NOW - TTL_MS - 1 });
    const { store, calls } = storeWith(expired);

    expect({
      bySession: await store.findBySessionToken('s'),
      byUser: await (store as unknown as { findByUserId(userId: string): Promise<WebAuthnAuthRecord[]>; }).findByUserId('u1'),
      calls,
    }).toEqual({ bySession: expired, byUser: [expired], calls: ['bound'] });
  });
});
