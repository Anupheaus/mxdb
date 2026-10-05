/**
 * The MongoDB filter that matches a pending invite, mirroring nexus's `isPendingWebAuthnInvite`: not enabled, and no key
 * hash, passkey credential, device details or connection. `field: null` matches a field that is missing or null, as `== null`
 * does in the predicate, and `$ne: true` matches `isEnabled` false or missing. Every pending-invite query (the registration
 * claim, the stale finder, the expiry sweep, the conditional delete) uses this, so none can drift from the predicate.
 */
export const PENDING_INVITE_FILTER = {
  isEnabled: { $ne: true },
  keyHash: null,
  credentialId: null,
  deviceDetails: null,
  lastConnectedAt: null,
} as const;
