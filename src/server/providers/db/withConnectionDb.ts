import { InternalError } from '@anupheaus/common';
import type { ConnectionDbTarget } from '../../internalModels';
import type { ConnectionDbPool } from './connectionDbRouter';
import { withDb } from './withDb';

let connectionDbPool: ConnectionDbPool | undefined;

/** Registers the server's per-connection `ServerDb` pool so {@link withConnectionDb} can reach it. Called once by `startServer`. */
export function setConnectionDbPool(pool: ConnectionDbPool): void {
  connectionDbPool = pool;
}

/**
 * Run `delegate` with the ambient mxdb database scoped to the pooled `ServerDb` for `target` — the same
 * watched instance client connections routed to that database use. For server-side work that belongs
 * to a routed (e.g. tenant) database but has no connection of its own, such as scheduled jobs: writes
 * go through that database's change stream, so `onAfter*` extension hooks and client sync fire exactly
 * once, and `onChange` subscriptions registered inside the delegate observe that database.
 */
export function withConnectionDb<R>(target: ConnectionDbTarget, delegate: () => R): R {
  if (connectionDbPool == null) {
    throw new InternalError('The connection database pool has not been initialised — withConnectionDb must be called after startServer.', {
      meta: { dbName: target.dbName },
    });
  }
  return withDb(connectionDbPool.getOrCreate(target), delegate);
}
