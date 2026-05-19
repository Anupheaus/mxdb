import type { SocketAPIAccount, SocketAPIUser } from '@anupheaus/nexus/common';

export interface MXDBUser extends SocketAPIUser { }

export interface MXDBAccount extends SocketAPIAccount { }

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

export interface MXDBDeviceInfo {
  requestId: string;
  userId: string;
  deviceDetails?: unknown;
  isEnabled: boolean;
  lastConnectedAt?: number;
}
