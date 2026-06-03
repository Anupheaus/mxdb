import type { ServerDb } from './providers';
import { setServerToClientSync } from './providers';
import { registerClientS2C, unregisterClientS2C } from './providers/db/clientS2CStore';
import { seedCollections } from './seeding';
import { internalActions } from './actions';
import {
  startServer as startSocketServer,
  useAction,
  useAuthentication as useSocketAuthentication,
} from '@anupheaus/nexus/server';
import { defineAuthentication } from '@anupheaus/nexus/server';
import { internalSubscriptions } from './subscriptions';
import { addClientWatches, removeClientWatches } from './clientDbWatches';
import { ServerToClientSynchronisation } from './ServerToClientSynchronisation';
import { WebAuthnAuthCollection } from './auth/WebAuthnAuthCollection';
import { GoogleOAuthAuthCollection } from './auth/GoogleOAuthAuthCollection';
import { registerDevAuthRoute } from './auth/registerDevAuthRoute';
import { mxdbServerToClientSyncAction } from '../common/internalActions';
import type { Socket } from 'socket.io';
import type { Koa, ServerAuthConfig, ServerConfig } from './internalModels';
import type { AuthCollection } from './auth/AuthCollection';
import type { NexusAuthRecord } from '@anupheaus/nexus/common';
import { Logger } from '@anupheaus/common';
import type { MXDBAccount, MXDBUser } from '../common/models';
import { parseSessionTokenFromHandshake } from './auth/parseSessionTokenFromHandshake';
import { registerMcpRoutes } from './mcp/McpRouter';
import { mxdbAdminClientSqlQueryAction } from '../common/mcpActions';
import type { MXDBRemoteSqliteQueryRequest, MXDBRemoteSqliteQueryResponse } from '../common/mcpModels';

export type ClientS2CState = {
  s2c: ServerToClientSynchronisation;
  emitAdminSqlQuery: (req: MXDBRemoteSqliteQueryRequest) => Promise<MXDBRemoteSqliteQueryResponse>;
};

const clientS2CInstances = new Map<Socket, ClientS2CState>();
const connectedUsers = new Map<Socket, MXDBUser>();
const connectedAccounts = new Map<Socket, MXDBAccount>();
const disconnectReasons = new Map<Socket, string>();

const adminUser = { id: Math.emptyId() } as MXDBUser;

export type ConnectedClientInfo = Readonly<{
  socketId: string;
  userId?: string;
  accountId?: string;
}>;

/**
 * Enumerate currently connected sockets with any resolved auth metadata.
 *
 * Auth metadata can be absent for newly connected sockets until the auth awaits
 * in `onClientConnected` complete.
 */
export function listConnectedClients(): ConnectedClientInfo[] {
  const out: ConnectedClientInfo[] = [];
  for (const socket of clientS2CInstances.keys()) {
    const user = connectedUsers.get(socket);
    const account = connectedAccounts.get(socket);
    out.push({
      socketId: socket.id,
      userId: user?.id,
      accountId: account?.id,
    });
  }
  return out;
}

interface Props extends ServerConfig {
  db: ServerDb;
}

function parseSessionToken(client: Socket): string | undefined {
  return parseSessionTokenFromHandshake({
    cookieHeader: client.handshake.headers.cookie as string | undefined,
    sessionTokenFromAuth: (client.handshake.auth as Record<string, unknown>)?.sessionToken as
      | string
      | undefined,
  });
}

function buildOnGetUser(authConfig: ServerAuthConfig) {
  return async (userId: string): Promise<MXDBUser | undefined> => {
    if (authConfig.onGetUserDetails == null) return { id: userId } as MXDBUser;
    try {
      return await authConfig.onGetUserDetails(userId);
    } catch {
      return undefined;
    }
  };
}

function createAuthCollection(
  auth: ServerAuthConfig,
  db: ServerDb,
): AuthCollection<NexusAuthRecord> {
  if (auth.mode === 'webauthn') return new WebAuthnAuthCollection(db);
  return new GoogleOAuthAuthCollection(db) as unknown as AuthCollection<NexusAuthRecord>;
}

export async function startAuthenticatedServer({
  db,
  shouldSeedCollections,
  collections,
  logger,
  actions,
  subscriptions,
  onClientConnected,
  onClientDisconnected,
  onConnected,
  onDisconnected,
  onGetAccountDetails,
  auth,
  changeStreamDebounceMs,
  ...config
}: Props): Promise<{ app: Koa; authColl: AuthCollection<NexusAuthRecord>; startListening: () => Promise<void>; stopListening: () => Promise<void> }> {
  const { configureAuthentication, useAuthentication } = defineAuthentication<
    MXDBUser,
    MXDBAccount
  >();
  const authColl = createAuthCollection(auth, db);

  const socketAuth =
    auth.mode === 'webauthn'
      ? configureAuthentication({
          mode: 'webauthn',
          store: authColl as WebAuthnAuthCollection,
          onGetInviteDetails: async (userId, accountId) => {
            if (auth.onGetInviteDetails == null)
              throw new Error('onGetInviteDetails is required for WebAuthn servers');
            return auth.onGetInviteDetails(userId, accountId);
          },
          onGetUser: buildOnGetUser(auth),
        })
      : configureAuthentication({
          mode: 'google-oauth',
          store: authColl as unknown as GoogleOAuthAuthCollection,
          clientId: auth.clientId,
          clientSecret: auth.clientSecret,
          redirectUri: auth.redirectUri,
          baseScopes: auth.baseScopes,
          capacitorCallbackUrl: auth.capacitorCallbackUrl,
          syncUserToClient: auth.syncUserToClient ?? false,
          onGetUser: buildOnGetUser(auth),
          onCreateUser: auth.onCreateUser,
        });

  logger?.info('[startAuthenticatedServer] calling startSocketServer');
  const { app, startListening, stopListening } = await startSocketServer({
    ...config,
    logger,
    actions: [...internalActions, ...(actions ?? [])],
    subscriptions: [...internalSubscriptions, ...(subscriptions ?? [])],
    auth: socketAuth,

    async onStartup() {
      logger?.info('[startAuthenticatedServer] onStartup.begin');
      const { impersonateUser } = useAuthentication();
      await impersonateUser(adminUser, async () => {
        const startupLogger = (
          logger ?? Logger.getCurrent() ?? new Logger('mxdb')
        ).createSubLogger('s2c:startup');
        setServerToClientSync(
          ServerToClientSynchronisation.createNoOp(collections, startupLogger),
        );
        const startTime = Date.now();
        if (shouldSeedCollections === true) await seedCollections(collections);
        startupLogger.info(`Seeding took ${Date.now() - startTime}ms`);
        if (config.onStartup != null) await config.onStartup();
      });
      logger?.info('[startAuthenticatedServer] onStartup.done');
    },

    onRegisterRoutes: async router => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerMcpRoutes(router as any, {
        logger,
        clientS2CInstances,
      });
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        registerDevAuthRoute(router as any, config.name, authColl, auth.mode);
      }
      await config.onRegisterRoutes?.(router);
    },

    onClientConnected: async (client: Socket) => {
      client.once('disconnect', (reason: string) => disconnectReasons.set(client, reason));

      // Register the real S2C instance BEFORE any await so that C2S action handlers
      // arriving during the auth awaits below never see the no-op fallback.
      const s2cLogger = (
        logger ?? Logger.getCurrent() ?? new Logger('mxdb')
      ).createSubLogger(`s2c:${client.id}`);
      const emitS2C = useAction(mxdbServerToClientSyncAction);
      const emitAdminSqlQuery = useAction(mxdbAdminClientSqlQueryAction);
      const s2c = new ServerToClientSynchronisation({
        emitS2C: async payload => emitS2C(payload),
        getDb: () => db,
        collections,
        logger: s2cLogger,
        clientId: client.id,
      });
      clientS2CInstances.set(client, {
        s2c,
        emitAdminSqlQuery: async req => emitAdminSqlQuery(req),
      });
      registerClientS2C(client, s2c);
      setServerToClientSync(s2c);
      addClientWatches(client, collections, s2c);

      const socketAuthCtx = useSocketAuthentication<MXDBUser, MXDBAccount>();

      if (socketAuthCtx.user != null) {
        if (socketAuthCtx.account == null && onGetAccountDetails != null) {
          const sessionToken = parseSessionToken(client);
          if (sessionToken != null) {
            const record = await authColl.findBySessionToken(sessionToken);
            logger?.info('[Auth] Resolving account from session auth record', {
              userId: socketAuthCtx.user.id,
              hasSessionToken: true,
              authRecordAccountId: record?.accountId,
            });
            if (record?.accountId != null) {
              const resolvedAccount = await onGetAccountDetails(record.accountId).catch(
                () => undefined,
              );
              if (resolvedAccount != null) {
                await socketAuthCtx.setAccount(resolvedAccount);
              } else {
                logger?.warn('[Auth] Auth record accountId could not be resolved', {
                  userId: socketAuthCtx.user.id,
                  accountId: record.accountId,
                });
              }
            } else {
              logger?.warn('[Auth] Session auth record has no accountId — client account will be unset', {
                userId: socketAuthCtx.user.id,
                requestId: record?.requestId,
              });
            }
          } else {
            logger?.warn('[Auth] Cannot resolve account — no session token available after connect', {
              userId: socketAuthCtx.user.id,
            });
          }
        }
        await socketAuthCtx.setUser(socketAuthCtx.user);
        connectedUsers.set(client, socketAuthCtx.user);
        const currentAccount = socketAuthCtx.account;
        // Re-emit account on every connect. Server auth context can retain account across
        // reconnects (same Connection scope) while the client resets on each new socket —
        // skipping setAccount when account is already set leaves the client with no account.
        if (currentAccount != null) {
          await socketAuthCtx.setAccount(currentAccount);
          connectedAccounts.set(client, currentAccount);
          logger?.info('[Auth] Account synced to client on connect', {
            userId: socketAuthCtx.user.id,
            accountId: currentAccount.id,
          });
        }
        await onConnected?.({ user: socketAuthCtx.user, account: currentAccount });
      }
      // Signal the client that the session-cookie auth check is complete, regardless of
      // whether the user was found. The client waits for this before triggering WebAuthn,
      // so it can skip the ceremony when a valid cookie already authenticated the user.
      client.emit('socketapi:authCheckComplete');
      client.emit('nexus:authCheckComplete');

      await onClientConnected?.(client);
    },

    onClientDisconnected: async client => {
      removeClientWatches(client);
      unregisterClientS2C(client);

      const state = clientS2CInstances.get(client);
      if (state != null) {
        state.s2c.close();
        clientS2CInstances.delete(client);
      }

      const user = connectedUsers.get(client);
      const account = connectedAccounts.get(client);
      connectedUsers.delete(client);
      connectedAccounts.delete(client);

      const rawReason = disconnectReasons.get(client) ?? '';
      disconnectReasons.delete(client);

      if (user != null) {
        const reason =
          rawReason === 'server namespace disconnect' ? 'signedOut' : 'connectionLost';
        await onDisconnected?.({ user, account, reason });
      }

      await onClientDisconnected?.(client);
    },
  });

  logger?.info('[startAuthenticatedServer] done');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { app: app as any as Koa, authColl, startListening, stopListening };
}
