import { describe, expect, it, vi } from 'vitest';
import type { WebAuthnAuthRecord, WebAuthnAuthStore } from '@anupheaus/nexus/common';
import { assertInviteTtlMs, withInviteExpiry } from './withInviteExpiry';

// nexus redeems an invite through `findById` (opening the link) and `findByRegistrationToken` (finishing registration).
// Both must see ONLY a pending invite younger than the invite lifetime: an old invite must not work before the nightly
// sweep deletes it, and a registered device must never be redeemable again — its record keeps the invite's requestId,
// so after a sign-out or an admin disable, whoever holds the old link could otherwise register over it. Every other
// lookup is untouched.

const TTL_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function record(overrides: Partial<WebAuthnAuthRecord>): WebAuthnAuthRecord {
  return { requestId: 'r1', sessionToken: '', userId: 'u1', deviceId: '', isEnabled: false, createdAt: NOW - 1_000, ...overrides };
}

/** A registered device, long since created: it has a key hash and device details. */
const registered = (overrides: Partial<WebAuthnAuthRecord> = {}) =>
  record({ isEnabled: true, keyHash: 'k1', deviceDetails: { name: 'Pixel' } as never, createdAt: NOW - 30 * TTL_MS, ...overrides });

/** An in-memory store holding one record, found by any lookup alike. */
function storeWith(held: WebAuthnAuthRecord, extra: Partial<WebAuthnAuthStore> = {}) {
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
    ...extra,
  } as never;
  return { store: withInviteExpiry(store, TTL_MS, () => NOW), calls };
}

const redeemed = async (store: WebAuthnAuthStore) => [await store.findById('r1'), await store.findByRegistrationToken('t')];

describe('withInviteExpiry', () => {
  it('redeems a pending invite whose registration fields are stored as explicit nulls', async () => {
    const { store } = storeWith(record({ keyHash: null, deviceDetails: null, lastConnectedAt: null } as unknown as Partial<WebAuthnAuthRecord>));

    expect((await redeemed(store)).map(found => found?.requestId)).toEqual(['r1', 'r1']);
  });

  it('redeems a pending invite younger than the lifetime', async () => {
    const { store } = storeWith(record({ createdAt: NOW - TTL_MS + 1 }));

    expect((await redeemed(store)).map(found => found?.requestId)).toEqual(['r1', 'r1']);
  });

  it.each([
    ['older than the lifetime', NOW - TTL_MS - 1],
    ['with no creation time (cannot be dated, so fails closed)', undefined],
    ['whose creation time is a string, however recent (JavaScript would coerce it)', String(NOW) as unknown as number],
    ['whose creation time is a date', new Date(NOW) as unknown as number],
  ])('treats a pending invite %s as not found, when opened and when registering', async (_label, createdAt) => {
    const { store } = storeWith(record({ createdAt }));

    expect(await redeemed(store)).toEqual([undefined, undefined]);
  });

  it.each([
    ['signed out (disabled, with its device details)', registered({ isEnabled: false })],
    ['disabled by an admin (only a key hash left)', registered({ isEnabled: false, deviceDetails: undefined })],
    ['enabled', registered()],
    ['registered only moments ago, inside the invite lifetime', registered({ isEnabled: false, createdAt: NOW - 1_000 })],
  ])('never lets a registered device be redeemed again: %s', async (_label, device) => {
    const { store } = storeWith(device);

    expect(await redeemed(store)).toEqual([undefined, undefined]);
  });

  it('still finds an old registered device by its key hash and session token, so re-authentication works', async () => {
    const device = registered();
    const { store } = storeWith(device);

    expect([await store.findByKeyHash('k1'), await store.findBySessionToken('s')]).toEqual([device, device]);
  });

  it('claims a registration only inside the invite lifetime: the store is asked for invites created since then', async () => {
    const claim = vi.fn(async () => record({}));
    const { store } = storeWith(record({}), { claimRegistration: claim });

    const claimed = await store.claimRegistration!('t', { keyHash: 'k1' });

    expect({ claimed: claimed?.requestId, calls: claim.mock.calls }).toEqual({
      claimed: 'r1',
      calls: [['t', { keyHash: 'k1' }, { createdSince: NOW - TTL_MS }]],
    });
  });

  it('refuses the registration when the store claims nothing (expired, already used, or registered since)', async () => {
    const { store } = storeWith(record({}), { claimRegistration: async () => undefined });

    expect(await store.claimRegistration!('t', { keyHash: 'k1' })).toBeUndefined();
  });

  it('reads the clock at every lookup by default, so an invite ages while the server runs (and under fake timers)', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const held = record({ createdAt: NOW });
      const store = withInviteExpiry({ findById: async () => held } as unknown as WebAuthnAuthStore, TTL_MS);
      const inDate = await store.findById('r1');
      vi.setSystemTime(NOW + TTL_MS + 1);

      expect([inDate?.requestId, await store.findById('r1')]).toEqual(['r1', undefined]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds no claim to a store without one, so nexus falls back to its gated find then update', () => {
    const { store } = storeWith(record({}));

    expect(store.claimRegistration).toBeUndefined();
  });

  it('leaves the other lookups running against the store itself', async () => {
    const { store, calls } = storeWith(record({}));

    await (store as unknown as { findByUserId(userId: string): Promise<WebAuthnAuthRecord[]>; }).findByUserId('u1');

    expect(calls).toEqual(['bound']);
  });
});

describe('assertInviteTtlMs', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s', ttl => {
    expect(() => assertInviteTtlMs(ttl)).toThrow('inviteTtlMs must be a positive, finite number of milliseconds');
  });

  it('accepts a positive lifetime', () => {
    expect(() => assertInviteTtlMs(TTL_MS)).not.toThrow();
  });
});
