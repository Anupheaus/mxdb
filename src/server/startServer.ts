import { provideDb, ServerDb, createConnectionDbPool } from './providers';
import { Logger } from '@anupheaus/common';
import { startAuthenticatedServer } from './startAuthenticatedServer';
import { getDevices, enableDevice, disableDevice, deleteDevice, expireStalePendingInvites } from './auth/deviceManagement';
import { setAuthDevices } from './auth/useAuthDevices';
import { useAuthentication } from '@anupheaus/nexus/server';
import type { WebAuthnAuthRecord } from '@anupheaus/nexus/common';
import type { ServerConfig, ServerInstance } from './internalModels';

/**
 * Initialises the MXDB-sync server: connects to MongoDB, starts Socket.IO, registers auth,
 * wires actions/subscriptions, and optionally seeds collections.
 *
 * `config.auth.mode` selects the authentication strategy:
 * - `'webauthn'` — passkey-based multi-device auth; exposes `createInvite` on the instance.
 * - `'google-oauth'` — Google OAuth 2.0; no invite flow.
 */
export async function startServer(config: ServerConfig): Promise<ServerInstance> {
  let { logger, name, collections, mongoDbName, mongoDbUrl, changeStreamDebounceMs } = config;
  if (!logger) logger = Logger.getCurrent();
  if (!logger) logger = new Logger('MXDB');

  logger.info('[startServer] begin', { name, mongoDbName, collectionCount: collections.length });

  // Pool of ServerDb instances for connections routed to a non-default tenant database via
  // `config.resolveConnectionDb` (see `connectionDbRouter.ts`). Unused — and never populated —
  // when `resolveConnectionDb` is not supplied, so the single-DB deployment is unaffected.
  const dbPool = createConnectionDbPool(target => new ServerDb({
    mongoDbName: target.dbName,
    mongoDbUrl: target.mongoDbUrl,
    collections,
    logger: logger!,
    watch: true,
  }));

  return logger.provide(() =>
    provideDb(mongoDbName, mongoDbUrl, collections, async db => {
      logger!.info('[startServer] provideDb — waiting for Mongo');
      await db.getMongoDb();
      logger!.info('[startServer] Mongo connected');

      const { app, authColl, startListening, stopListening, updateCertificate } = await startAuthenticatedServer({ ...config, db, logger, dbPool });

      if (app == null) throw new Error('Failed to start server');

      await startListening();

      const listForUser = async (userId: string) => getDevices(authColl, userId);
      const enable = async (requestId: string) => enableDevice(authColl, requestId);
      const disable = async (requestId: string) => disableDevice(authColl, requestId);
      const remove = async (requestId: string) => deleteDevice(authColl, requestId);

      setAuthDevices({
        listForUser,
        createInvite: async options => useAuthentication().createInvite(options),
        setEnabled: async (requestId, isEnabled) => {
          if (isEnabled) await enable(requestId);
          else await disable(requestId);
        },
        deleteDevice: remove,
        expireStalePendingInvites: async ttlMs => expireStalePendingInvites(authColl, ttlMs),
        findById: async requestId => authColl.findById(requestId) as Promise<WebAuthnAuthRecord | undefined>,
        create: async record => authColl.create(record),
        update: async (requestId, patch) => authColl.update(requestId, patch),
      });

      const instance: ServerInstance = {
        app,
        getDevices: listForUser,
        enableDevice: enable,
        disableDevice: disable,
        deleteDevice: remove,
        updateCertificate,
        close: async () => { await stopListening(); await db.close(); await dbPool.closeAll(); },
      };

      if (config.auth.mode === 'webauthn') {
        instance.createInvite = async options => useAuthentication().createInvite(options);
      }

      return instance;
    }, { changeStreamDebounceMs }),
  );
}
