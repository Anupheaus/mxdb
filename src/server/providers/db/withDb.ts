import { useLogger } from '@anupheaus/common';
import { runInDbScope, setDb, setServerToClientSync } from './DbContext';
import type { ServerDb } from './ServerDb';
import { ServerToClientSynchronisation } from '../../ServerToClientSynchronisation';

/**
 * Run `delegate` with the ambient mxdb database bound to an already-constructed ServerDb, without
 * constructing a new connection. Used to reuse a cached, watch-free ServerDb for reads/writes into a
 * non-default (e.g. control-plane or tenant) database. Establishes a no-op server->client sync (the
 * owning server's own change-stream watch propagates the write).
 *
 * The switch is SCOPED to `delegate` (via {@link runInDbScope}) and automatically restored when it
 * returns — it does NOT leak into the surrounding connection/request scope. Without this, a temporary
 * switch (e.g. reading a control-plane collection, or a scoped tenant-db write) would leave the
 * connection's ambient db pointing at the wrong database, so a later sync/handler on that same
 * connection would resolve collections against the wrong schema.
 */
export function withDb<R>(db: ServerDb, delegate: () => R): R {
  const logger = useLogger();
  return runInDbScope(() => {
    setDb(db);
    setServerToClientSync(ServerToClientSynchronisation.createNoOp([], logger.createSubLogger('s2c:noop')));
    return delegate();
  });
}
