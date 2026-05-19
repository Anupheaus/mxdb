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
import type { ServerAuthConfig, ServerConfig } from './internalModels';
import type { AuthCollection } from './auth/AuthCollection';
import type { SocketAPIAuthRecord } from '@anupheaus/nexus/common/auth';
import { Logger } from '@anupheaus/common';
import type { MXDBAccount, MXDBUser } from '../common/models';

const SESSION_COOKIE_NAME = 'socketapi_session';

const clientS2CInstances = new WeakMap<Socket, ServerToClientSynchronisation>();
const connectedUsers = new WeakMap<Socket, MXDBUser>();
const connectedAccounts = new WeakMap<Socket, MXDBAccount>();
const disconnectReasons = new WeakMap<Socket, string>();

const adminUser = { id: Math.emptyId() } as MXDBUser;

interface Props extends ServerConfig {
  db: ServerDb;
}

function parseSessionToken(client: Socket): string | undefined {
  const cookieHeader = client.handshake.headers.cookie as string | undefined;
  const fromCookie = cookieHeader
    ?.split(';')
    .map(s => s.trim())
    .find(s => s.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);
  const fromAuth = (client.handshake.auth as Record<string, unknown>)?.sessionToken as
    | string
    | undefined;
  return fromCookie ?? fromAuth;
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
): AuthCollection<SocketAPIAuthRecord> {
  if (auth.mode === 'webauthn') return new WebAuthnAuthCollection(db);
  return new GoogleOAuthAuthCollection(db) as unknown as AuthCollection<SocketAPIAuthRecord>;
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
}: Props) {
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
          logger ?? Logger.getCurrent() ?? new Logger('mxdb-sync')
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
      if (process.env.NODE_ENV !== 'production') {
        registerDevAuthRoute(router, config.name, authColl, auth.mode);
      }
      await config.onRegisterRoutes?.(router);
    },

    onClientConnected: async (client: Socket) => {
      client.once('disconnect', (reason: string) => disconnectReasons.set(client, reason));
      const socketAuthCtx = useSocketAuthentication<MXDBUser, MXDBAccount>();

      if (socketAuthCtx.user != null) {
        if (socketAuthCtx.account == null && onGetAccountDetails != null) {
          const sessionToken = parseSessionToken(client);
          if (sessionToken != null) {
            const record = await authColl.findBySessionToken(sessionToken);
            if (record?.accountId != null) {
              const resolvedAccount = await onGetAccountDetails(record.accountId).catch(
                () => undefined,
              );
              if (resolvedAccount != null) await socketAuthCtx.setAccount(resolvedAccount);
            }
          }
        }
        await socketAuthCtx.setUser(socketAuthCtx.user);
        connectedUsers.set(client, socketAuthCtx.user);
        const currentAccount = socketAuthCtx.account;
        if (currentAccount != null) connectedAccounts.set(client, currentAccount);
        await onConnected?.({ user: socketAuthCtx.user, account: currentAccount });
      }
      // Signal the client that the session-cookie auth check is complete, regardless of
      // whether the user was found. The client waits for this before triggering WebAuthn,
      // so it can skip the ceremony when a valid cookie already authenticated the user.
      client.emit('socketapi:authCheckComplete');

      const s2cLogger = (
        logger ?? Logger.getCurrent() ?? new Logger('mxdb-sync')
      ).createSubLogger(`s2c:${client.id}`);
      const emitS2C = useAction(mxdbServerToClientSyncAction);
      const s2c = new ServerToClientSynchronisation({
        emitS2C: async payload => emitS2C(payload),
        getDb: () => db,
        collections,
        logger: s2cLogger,
      });
      clientS2CInstances.set(client, s2c);
      registerClientS2C(client, s2c);
      setServerToClientSync(s2c);
      addClientWatches(client, collections, s2c);
      await onClientConnected?.(client);
    },

    onClientDisconnected: async client => {
      removeClientWatches(client);
      unregisterClientS2C(client);

      const s2c = clientS2CInstances.get(client);
      if (s2c != null) {
        s2c.close();
        clientS2CInstances.delete(client);
      }

      const user = connectedUsers.get(client);
      const account = connectedAccounts.get(client);
      connectedUsers.delete(client);
      connectedAccounts.delete(client);

      if (user != null) {
        const rawReason = disconnectReasons.get(client) ?? '';
        const reason =
          rawReason === 'server namespace disconnect' ? 'signedOut' : 'connectionLost';
        disconnectReasons.delete(client);
        await onDisconnected?.({ user, account, reason });
      }

      await onClientDisconnected?.(client);
    },
  });

  logger?.info('[startAuthenticatedServer] done');
  return { app, authColl, startListening, stopListening };
}
