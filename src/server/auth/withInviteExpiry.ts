import type { WebAuthnAuthRecord, WebAuthnAuthStore } from '@anupheaus/nexus/common';

/**
 * A pending invite: created by `createInvite` and never registered. A registered device has a key hash or device
 * details, has connected, or has been enabled, and stays registered after sign-out or an admin disable, when only
 * `isEnabled` goes back to false.
 */
function isPendingInvite(record: WebAuthnAuthRecord): boolean {
  return record.isEnabled !== true && record.keyHash == null && record.deviceDetails == null && record.lastConnectedAt == null;
}

/** Refuses anything but a positive, finite lifetime, so a typo cannot make invites never expire or always expire. */
export function assertInviteTtlMs(inviteTtlMs: number): void {
  if (!Number.isFinite(inviteTtlMs) || inviteTtlMs <= 0) {
    throw new Error(`inviteTtlMs must be a positive, finite number of milliseconds, but is ${inviteTtlMs}.`);
  }
}

/**
 * The WebAuthn store nexus redeems invites through. The two finders the redemption uses — `findById` (opening the invite
 * link) and `findByRegistrationToken` (finishing registration) — return a record ONLY when it is a pending invite younger
 * than `inviteTtlMs`:
 * - an older invite, or one with no `createdAt` (it cannot be dated), is not found, even before
 *   `expireStalePendingInvites` deletes it;
 * - a registered device is never found, however it is disabled: its record keeps the invite's `requestId` (the
 *   `?requestId=` in the emailed link), so returning it would let whoever holds the old link register over it after a
 *   sign-out or an admin disable.
 *
 * Every other lookup (`findBySessionToken`, `findByKeyHash`, …) passes through unchanged, and device management uses the
 * unwrapped collection.
 */
export function withInviteExpiry<TStore extends WebAuthnAuthStore>(store: TStore, inviteTtlMs: number, now: () => number = Date.now): TStore {
  assertInviteTtlMs(inviteTtlMs);
  const asRedeemableInvite = (record: WebAuthnAuthRecord | undefined): WebAuthnAuthRecord | undefined => {
    if (record == null || !isPendingInvite(record)) return undefined;
    return record.createdAt != null && record.createdAt >= now() - inviteTtlMs ? record : undefined;
  };
  return new Proxy(store, {
    get(target, property) {
      if (property === 'findById' || property === 'findByRegistrationToken') {
        return async (key: string) => asRedeemableInvite(await target[property](key));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
