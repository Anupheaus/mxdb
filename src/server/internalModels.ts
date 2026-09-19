import type { Http2Server } from 'http2';
import type { Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';
import type { MXDBAccount, MXDBDeviceInfo, MXDBUser } from '../common/models';
import type { MXDBCollection } from '../common';
import type { ServerConfig as StartSocketServerConfig, TLSCertificate } from '@anupheaus/nexus/server';
import type { CreateInviteOptions } from '@anupheaus/nexus/server';
import type { InviteDetails } from '@anupheaus/nexus/common';
import type { GoogleProfile } from '@anupheaus/nexus/common';
import type { PromiseMaybe } from '@anupheaus/common';
import type Koa from 'koa';

export type AnyHttpServer = Http2Server | HttpServer | HttpsServer;

export { Koa };

export interface WebAuthnServerAuthConfig {
  mode: 'webauthn';
  /** WebAuthn relying party ID — the domain registered devices authenticate against.
   *  Defaults to `'localhost'` in development. */
  rpId?: string;
  onGetUserDetails?(userId: string): Promise<MXDBUser>;
  onGetInviteDetails?(userId: string, accountId?: string): Promise<InviteDetails>;
}

export interface GoogleOAuthServerAuthConfig {
  mode: 'google-oauth';
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  baseScopes: string[];
  capacitorCallbackUrl?: string;
  syncUserToClient?: boolean;
  onGetUserDetails?(userId: string): Promise<MXDBUser>;
  onCreateUser(profile: GoogleProfile): Promise<MXDBUser>;
}

export type ServerAuthConfig = WebAuthnServerAuthConfig | GoogleOAuthServerAuthConfig;

/** Target database for a per-connection routing decision — see `ServerConfig.resolveConnectionDb`. */
export interface ConnectionDbTarget { dbName: string; mongoDbUrl: string; }

/** Minimal shape mxdb needs from the socket.io handshake to make a routing decision. */
export interface ConnectionHandshake { headers: Record<string, unknown>; auth?: Record<string, unknown>; query?: Record<string, unknown>; }

export interface ServerConfig extends Omit<StartSocketServerConfig, 'auth'> {
  collections: MXDBCollection[];
  mongoDbUrl: string;
  mongoDbName: string;
  clearDatabase?: boolean;
  shouldSeedCollections?: boolean;
  changeStreamDebounceMs?: number;
  auth: ServerAuthConfig;
  onGetAccountDetails?(accountId: string): Promise<MXDBAccount | undefined>;
  onConnected?(ctx: { user: MXDBUser; account?: MXDBAccount }): PromiseMaybe<void>;
  onDisconnected?(ctx: {
    user: MXDBUser;
    account?: MXDBAccount;
    reason: 'signedOut' | 'connectionLost';
  }): PromiseMaybe<void>;
  /**
   * Optional per-connection database router. When supplied, it is called (inside the per-connection
   * auth scope, before authentication) with the socket handshake; returning a target scopes THIS
   * connection to that database. Returning null leaves the connection on the default (startup) DB.
   * Absent → no per-connection routing (single-DB behaviour, unchanged).
   */
  resolveConnectionDb?(handshake: ConnectionHandshake): Promise<ConnectionDbTarget | null>;
}

export interface ServerInstance {
  app: Koa;
  /** Only available when `auth.mode === 'webauthn'`. */
  createInvite?(options: CreateInviteOptions): Promise<string>;
  getDevices(userId: string): Promise<MXDBDeviceInfo[]>;
  enableDevice(requestId: string): Promise<void>;
  disableDevice(requestId: string): Promise<void>;
  deleteDevice(requestId: string): Promise<void>;
  /**
   * Hot-swap the server's TLS certificate without a restart (via nexus `setSecureContext`) — for cert
   * renewal. No-op when the server is not HTTPS.
   */
  updateCertificate(cert: TLSCertificate): void;
  close(): Promise<void>;
}
