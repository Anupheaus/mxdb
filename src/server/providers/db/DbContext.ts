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
