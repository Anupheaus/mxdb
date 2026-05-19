import { provideDb } from './providers';
import { Logger } from '@anupheaus/common';
import { startAuthenticatedServer } from './startAuthenticatedServer';
import { getDevices, enableDevice, disableDevice } from './auth/deviceManagement';
import { useAuthentication } from '@anupheaus/socket-api/server';
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
  if (!logger) logger = new Logger('MXDB-Sync');

  logger.info('[startServer] begin', { name, mongoDbName, collectionCount: collections.length });

  return logger.provide(() =>
    provideDb(mongoDbName, mongoDbUrl, collections, async db => {
      logger!.info('[startServer] provideDb — waiting for Mongo');
      await db.getMongoDb();
      logger!.info('[startServer] Mongo connected');

      const { app, authColl, startListening, stopListening } = await startAuthenticatedServer({ ...config, db, logger });

      if (app == null) throw new Error('Failed to start server');

      await startListening();

      const instance: ServerInstance = {
        app,
        getDevices: async (userId: string) => getDevices(authColl, userId),
        enableDevice: async (requestId: string) => enableDevice(authColl, requestId),
        disableDevice: async (requestId: string) => disableDevice(authColl, requestId),
        close: async () => { await stopListening(); await db.close(); },
      };

      if (config.auth.mode === 'webauthn') {
        instance.createInvite = async options => useAuthentication().createInvite(options);
      }

      return instance;
    }, changeStreamDebounceMs),
  );
}
