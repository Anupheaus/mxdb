import { provideDb } from './providers';
import { Logger } from '@anupheaus/common';
import { startAuthenticatedServer } from './startAuthenticatedServer';
import { getDevices, enableDevice, disableDevice, deleteDevice, expireStalePendingInvites } from './auth/deviceManagement';
import { setAuthDevices } from './auth/useAuthDevices';
import { useAuthentication } from '@anupheaus/nexus/server';
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

  return logger.provide(() =>
    provideDb(mongoDbName, mongoDbUrl, collections, async db => {
      logger!.info('[startServer] provideDb — waiting for Mongo');
      await db.getMongoDb();
      logger!.info('[startServer] Mongo connected');

      const { app, authColl, startListening, stopListening } = await startAuthenticatedServer({ ...config, db, logger });

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
      });

      const instance: ServerInstance = {
        app,
        getDevices: listForUser,
        enableDevice: enable,
        disableDevice: disable,
        deleteDevice: remove,
        close: async () => { await stopListening(); await db.close(); },
      };

      if (config.auth.mode === 'webauthn') {
        instance.createInvite = async options => useAuthentication().createInvite(options);
      }

      return instance;
    }, changeStreamDebounceMs),
  );
}
