import { useLogger } from '@anupheaus/common';
import { setDb, setServerToClientSync } from './DbContext';
import type { ServerDb } from './ServerDb';
import { ServerToClientSynchronisation } from '../../ServerToClientSynchronisation';

/**
 * Run `delegate` with the ambient mxdb database bound to an already-constructed ServerDb, without
 * constructing a new connection. Used to reuse a cached, watch-free ServerDb for writes into a
 * non-default tenant database. Establishes a no-op server->client sync (the owning server's own
 * change-stream watch propagates the write).
 */
export function withDb<R>(db: ServerDb, delegate: () => R): R {
  const logger = useLogger();
  setDb(db);
  setServerToClientSync(ServerToClientSynchronisation.createNoOp([], logger.createSubLogger('s2c:noop')));
  return delegate();
}
