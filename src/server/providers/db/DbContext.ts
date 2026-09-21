import { createAsyncContext, required, useClient } from '@anupheaus/nexus/server';
import type { ServerDb } from './ServerDb';
import type { ServerToClientSynchronisation } from '../../ServerToClientSynchronisation';
import { lookupClientS2C } from './clientS2CStore';

const ctx = createAsyncContext({
  db: required<ServerDb>(),
  serverToClientSync: required<ServerToClientSynchronisation>(),
});

export const setDb = ctx.setDb;
export const useDb = ctx.useDb;
export const setServerToClientSync = ctx.setServerToClientSync;

/**
 * Run `delegate` inside a fresh db-context scope frame. Any `setDb`/`setServerToClientSync` performed
 * within `delegate` is confined to this frame and automatically discarded when it returns (and its
 * async continuations settle), so a temporary db switch never leaks into the surrounding
 * connection/request scope.
 *
 * This is the opposite of the deliberate bare `setDb` used by the connection router and the startup
 * `provideDb`, which set the ambient db for the whole connection / process on purpose.
 */
export function runInDbScope<R>(delegate: () => R): R {
  return ctx.wrap({}, delegate)();
}

const useServerToClientSyncContext = ctx.useServerToClientSync;

/** Per-connection S2C synchronisation wrapper exposed to action handlers via async context. */
export function useServerToClientSynchronisation(): ServerToClientSynchronisation {
  const client = useClient();
  if (client != null) {
    const s2c = lookupClientS2C(client);
    if (s2c != null) return s2c;
  }
  return useServerToClientSyncContext();
}
