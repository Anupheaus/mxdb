import type { NexusAccount, NexusUser } from '@anupheaus/nexus/common';

// Re-export the device form-factor type (and its pure derivation helper) so consumers can import
// them from `@anupheaus/mxdb/common` without also depending on `@anupheaus/nexus` directly.
export type { DeviceFormFactor } from '@anupheaus/nexus/common';
export { deriveDeviceFormFactor } from '@anupheaus/nexus/common';

export interface MXDBUser extends NexusUser { }

export interface MXDBAccount extends NexusAccount { }

/**
 * Base shape for an `mxdb_authentication` document — matches `SocketAPIAuthRecord`.
 * Used for device-management APIs that work regardless of auth mode.
 */
export interface MXDBAuthRecord {
  requestId: string;
  userId: string;
  sessionToken: string;
  deviceId: string;
  deviceDetails?: unknown;
  isEnabled: boolean;
  lastConnectedAt?: number;
  accountId?: string;
}

/**
 * Extra fields stored when the server is running in `google-oauth` mode.
 */
export interface MXDBGoogleOAuthAuthRecord extends MXDBAuthRecord {
  googleAccessToken: string;
  googleRefreshToken: string;
  /** Unix timestamp (ms) when `googleAccessToken` expires. */
  googleTokenExpiresAt: number;
  grantedScopes: string[];
}

/**
 * Where a device is in its life: `pending` (an invite that has never registered, by nexus's `isPendingWebAuthnInvite`),
 * `active` (registered and enabled) or `disabled` (registered, then signed out or disabled by an admin).
 */
export type MXDBDeviceStatus = 'pending' | 'active' | 'disabled';

export interface MXDBDeviceInfo {
  requestId: string;
  userId: string;
  deviceDetails?: unknown;
  isEnabled: boolean;
  lastConnectedAt?: number;
  /** Derived from the record with nexus's pending-invite definition; use it rather than testing the fields yourself. */
  status: MXDBDeviceStatus;
}
