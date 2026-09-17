import type { ConnectionDbTarget, ConnectionHandshake } from '../../internalModels';
import type { ServerDb } from './ServerDb';

/** Dependencies for `resolveAndScopeConnection`, injected so the routing logic is unit-testable
 *  without a real Mongo connection or socket. */
export interface ConnectionDbRouterDeps {
  resolveConnectionDb(handshake: ConnectionHandshake): Promise<ConnectionDbTarget | null>;
  getOrCreateServerDb(target: ConnectionDbTarget): ServerDb;
  setDb(db: ServerDb): void;
}

/** A get-or-create pool of `ServerDb` keyed by `${mongoDbUrl}::${dbName}`, so repeated connections
 *  routed to the same tenant database share one MongoClient rather than reconnecting per socket. */
export interface ConnectionDbPool {
  getOrCreate(target: ConnectionDbTarget): ServerDb;
  closeAll(): Promise<void>;
}

function poolKey(target: ConnectionDbTarget): string {
  return `${target.mongoDbUrl}::${target.dbName}`;
}

export function createConnectionDbPool(makeServerDb: (target: ConnectionDbTarget) => ServerDb): ConnectionDbPool {
  const pool = new Map<string, ServerDb>();

  return {
    getOrCreate(target: ConnectionDbTarget): ServerDb {
      const key = poolKey(target);
      const existing = pool.get(key);
      if (existing != null) return existing;
      const created = makeServerDb(target);
      pool.set(key, created);
      return created;
    },
    async closeAll(): Promise<void> {
      const dbs = [...pool.values()];
      pool.clear();
      await Promise.all(dbs.map(db => db.close()));
    },
  };
}

/**
 * Resolve the target database for this connection's handshake and, when one is returned, scope the
 * ambient per-connection DB context to the pooled `ServerDb` for it. A null resolution is a no-op —
 * the connection stays on the default (startup) DB.
 */
export async function resolveAndScopeConnection(handshake: ConnectionHandshake, deps: ConnectionDbRouterDeps): Promise<void> {
  const target = await deps.resolveConnectionDb(handshake);
  if (target == null) return;
  deps.setDb(deps.getOrCreateServerDb(target));
}
