/**
 * Shared e2e infrastructure identifiers (not the old `tests/sync-test` harness).
 * Child process env keys and defaults stay here so `serverLifecycle` / `serverProcess.ts` stay aligned.
 */

/** Mongo database name for Memory Server + forked HTTPS server. */
export const E2E_MONGO_DB_NAME = 'mxdb-e2e';

/**
 * Logical name for {@link startServer} and the client {@link SocketAPI} — they must match.
 * Distinct from the default live **collection** name (`e2eTest` on that database).
 */
export const E2E_SOCKET_API_NAME = 'mxdb-e2e';

/** Environment variables the parent passes into `serverProcess.ts`. */
export const E2E_SERVER_PROCESS_ENV = {
  PORT: 'MXDB_E2E_SERVER_PORT',
  MONGO_URI: 'MXDB_E2E_MONGO_URI',
  MONGO_DB_NAME: 'MXDB_E2E_MONGO_DB_NAME',
} as const;

/** Default IndexedDB / SQLite DB name prefix when `createSyncClient` is used without `dbName`. */
export const E2E_DEFAULT_CLIENT_DB_PREFIX = 'mxdb-e2e-client';
