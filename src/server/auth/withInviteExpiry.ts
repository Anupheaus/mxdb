import { isPendingWebAuthnInvite, type WebAuthnAuthRecord, type WebAuthnAuthStore } from '@anupheaus/nexus/common';
import type { ClaimRegistrationOptions } from './WebAuthnAuthCollection';

/** A store's `claimRegistration` that also takes the invite-lifetime condition, as `WebAuthnAuthCollection`'s does. */
type ClaimRegistration = (registrationToken: string, patch: Partial<WebAuthnAuthRecord>, options?: ClaimRegistrationOptions) => Promise<WebAuthnAuthRecord | undefined>;

/** Refuses anything but a positive, finite lifetime, so a typo cannot make invites never expire or always expire. */
export function assertInviteTtlMs(inviteTtlMs: number): void {
  if (!Number.isFinite(inviteTtlMs) || inviteTtlMs <= 0) {
    throw new Error(`inviteTtlMs must be a positive, finite number of milliseconds, but is ${inviteTtlMs}.`);
  }
}

/**
 * The WebAuthn store nexus redeems invites through. Every step of the redemption sees ONLY a pending invite (nexus's
 * `isPendingWebAuthnInvite`) younger than `inviteTtlMs`:
 * - `findById` (opening the invite link) and `findByRegistrationToken` (finishing registration) return nothing else;
 * - `claimRegistration` (the atomic registration write) matches nothing else, so an invite opened inside the lifetime
 *   but finished after it is refused. A store without `claimRegistration` stays without it, and nexus falls back to a
 *   find (gated as above) then an update.
 *
 * So an older invite, or one with no `createdAt` (it cannot be dated), cannot be redeemed, even before
 * `expireStalePendingInvites` deletes it. A registered device can never be redeemed again, however it is disabled: its
 * record keeps the invite's `requestId` (the `?requestId=` in the emailed link), so returning it would let whoever holds
 * the old link register over it after a sign-out or an admin disable.
 *
 * Every other lookup (`findBySessionToken`, `findByKeyHash`, …) passes through unchanged, and device management uses the
 * unwrapped collection.
 */
export function withInviteExpiry<TStore extends WebAuthnAuthStore>(store: TStore, inviteTtlMs: number, now: () => number = () => Date.now()): TStore {
  assertInviteTtlMs(inviteTtlMs);
  const createdSince = () => now() - inviteTtlMs;
  const asRedeemableInvite = (record: WebAuthnAuthRecord | undefined): WebAuthnAuthRecord | undefined => {
    if (record == null || !isPendingWebAuthnInvite(record)) return undefined;
    return record.createdAt != null && record.createdAt >= createdSince() ? record : undefined;
  };
  return new Proxy(store, {
    get(target, property) {
      if (property === 'findById' || property === 'findByRegistrationToken') {
        return async (key: string) => asRedeemableInvite(await target[property](key));
      }
      if (property === 'claimRegistration') {
        const claim = Reflect.get(target, property, target) as ClaimRegistration | undefined;
        if (typeof claim !== 'function') return undefined;
        // The store applies the lifetime inside its atomic write, so a claim that succeeds was pending and in date then.
        return (registrationToken: string, patch: Partial<WebAuthnAuthRecord>) =>
          claim.call(target, registrationToken, patch, { createdSince: createdSince() });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
