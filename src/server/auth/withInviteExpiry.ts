import type { WebAuthnAuthRecord, WebAuthnAuthStore } from '@anupheaus/nexus/common';

/**
 * A pending invite: created by `createInvite` and never registered. A registered device carries device details or has
 * connected, and is enabled once registration completes.
 */
function isPendingInvite(record: WebAuthnAuthRecord): boolean {
  return record.isEnabled !== true && record.deviceDetails == null && record.lastConnectedAt == null;
}

/**
 * The WebAuthn store nexus redeems invites through, with invites older than `inviteTtlMs` treated as not found, so an
 * old link cannot be redeemed even before a sweep (`expireStalePendingInvites`) has deleted it. Only the two finders
 * the redemption uses are filtered — `findById` (opening the invite link) and `findByRegistrationToken` (completing
 * registration) — so device management, which uses the collection directly, still sees every record. A pending invite
 * with no `createdAt` cannot be dated, so it fails closed and is not redeemable either.
 */
export function withInviteExpiry<TStore extends WebAuthnAuthStore>(store: TStore, inviteTtlMs: number, now: () => number = Date.now): TStore {
  const isRedeemable = (record: WebAuthnAuthRecord | undefined): WebAuthnAuthRecord | undefined => {
    if (record == null || !isPendingInvite(record)) return record;
    return record.createdAt != null && record.createdAt >= now() - inviteTtlMs ? record : undefined;
  };
  return new Proxy(store, {
    get(target, property) {
      if (property === 'findById' || property === 'findByRegistrationToken') {
        return async (key: string) => isRedeemable(await target[property](key));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
