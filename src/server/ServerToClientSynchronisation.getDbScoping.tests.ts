import { describe, it, expect, beforeEach } from 'vitest';
import '@anupheaus/common'; // installs array extensions (.ids()) used by ServerToClientSynchronisation
import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import { createAsyncContext } from '@anupheaus/nexus/server';
import { defineCollection } from '../common';
import type { MXDBRecordCursors, MXDBSyncEngineResponse } from '../common/sync-engine';
import { ServerToClientSynchronisation } from './ServerToClientSynchronisation';
import { setDb, useDb } from './providers';
import type { ServerDb } from './providers/db/ServerDb';

/**
 * Phase 2b regression: `startAuthenticatedServer.ts` wires the real S2C's `getDb` to
 * `() => useDb()` instead of a startup-captured `ServerDb`, so per-connection routing
 * (Phase 2a's `setDb` inside the connection scope) redirects S2C reads at the tenant DB.
 *
 * `ServerToClientSynchronisation` itself is untouched — it just calls the injected `getDb`
 * closure (see `#buildAndPush` / `#buildDeleteCursors`). This exercises that EXACT closure
 * (`getDb: () => useDb()`) against real `setDb`/`useDb`, using a throwaway `createAsyncContext`
 * purely to obtain a `wrap()` — it shares nexus's module-level `chainStorage`, so entering a
 * scope here is exactly what nexus's per-connection `wrap()` does around `onClientConnected`
 * in production (see `startAuthenticatedServer.ts`'s `onClientConnected` and
 * `connectionDbRouter.ts`'s `resolveAndScopeConnection`).
 */

interface TaggedItem extends MXDBRecord {
  id: string;
  source: string;
}

const taggedCollection = defineCollection<TaggedItem>({
  name: 'taggedItems',
  indexes: [],
  disableAudit: true, // keeps the fake ServerDb's `.use()` to just `get(ids)` — no audit calls
});

function makeLogger(): Logger {
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    silly: () => undefined,
    createSubLogger: () => logger,
  };
  return logger as unknown as Logger;
}

/** A fake ServerDb whose `.use().get()` always returns records tagged with `label`, so a
 *  captured cursor's `source` field reveals which ServerDb answered the query. */
function makeFakeDb(label: string): ServerDb {
  return {
    use(_collectionName: string) {
      return {
        async get(ids: string[]): Promise<TaggedItem[]> {
          return ids.map(id => ({ id, source: label }));
        },
      };
    },
  } as unknown as ServerDb;
}

// Obtained purely for `wrap()` — shares nexus's module-level chainStorage with mxdb's real
// `setDb`/`useDb` (both ultimately close over the same `AsyncLocalStorage` singleton), so this
// is not a mock: it is the same mechanism nexus's own per-connection `wrap()` uses.
const { wrap } = createAsyncContext({});

/** `pushActive` takes the base `MXDBRecord[]` type, so an inline `{ id, source }` literal
 *  fails the excess-property check; this helper types the object as `TaggedItem` first. */
function taggedItem(id: string, source: string): TaggedItem {
  return { id, source };
}

describe('ServerToClientSynchronisation — getDb wired through useDb() (per-connection routing)', () => {
  let emitted: MXDBRecordCursors[];
  let s2c: ServerToClientSynchronisation;

  beforeEach(() => {
    emitted = [];
    s2c = new ServerToClientSynchronisation({
      emitS2C: async (payload: MXDBRecordCursors): Promise<MXDBSyncEngineResponse> => {
        emitted.push(payload);
        return payload.map(({ collectionName, records }) => ({
          collectionName,
          successfulRecordIds: records.map(r => ('recordId' in r ? r.recordId : r.record.id)),
        }));
      },
      // The exact production wiring (startAuthenticatedServer.ts) — resolved fresh on every
      // call via useDb(), NOT a startup-captured ServerDb.
      getDb: () => useDb(),
      collections: [taggedCollection],
      logger: makeLogger(),
      clientId: 'test-client',
    });
  });

  it('falls back to the global default ServerDb when there is no active connection scope', async () => {
    const globalDb = makeFakeDb('global');
    setDb(globalDb); // called with no active scope → sets the global default, exactly like provideDb() at startup

    await s2c.pushActive('taggedItems', [taggedItem('rec-1', 'unset')]);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]![0]!.records[0]).toEqual(
      expect.objectContaining({ record: expect.objectContaining({ source: 'global' }) }),
    );
  });

  it('routes to the per-connection ServerDb set inside a connection scope, not the global default', async () => {
    const globalDb = makeFakeDb('global');
    setDb(globalDb);
    const tenantDb = makeFakeDb('tenant-a');

    await wrap(() => ({}), async () => {
      setDb(tenantDb); // mirrors Phase 2a's router calling setDb inside the connection scope
      await s2c.pushActive('taggedItems', [taggedItem('rec-1', 'unset')]);
    })();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]![0]!.records[0]).toEqual(
      expect.objectContaining({ record: expect.objectContaining({ source: 'tenant-a' }) }),
    );
  });

  it('does not leak the per-connection db after the scope exits — later calls fall back to the global default', async () => {
    const globalDb = makeFakeDb('global');
    setDb(globalDb);
    const tenantDb = makeFakeDb('tenant-a');

    await wrap(() => ({}), async () => {
      setDb(tenantDb);
      await s2c.pushActive('taggedItems', [taggedItem('rec-1', 'unset')]);
    })();

    await s2c.pushActive('taggedItems', [taggedItem('rec-2', 'unset')]);

    expect(emitted).toHaveLength(2);
    expect(emitted[1]![0]!.records[0]).toEqual(
      expect.objectContaining({ record: expect.objectContaining({ source: 'global' }) }),
    );
  });

  it('routes distinct connection scopes to distinct tenant DBs on the same long-lived S2C instance', async () => {
    setDb(makeFakeDb('global'));
    const tenantA = makeFakeDb('tenant-a');
    const tenantB = makeFakeDb('tenant-b');

    await wrap(() => ({}), async () => {
      setDb(tenantA);
      await s2c.pushActive('taggedItems', [taggedItem('rec-1', 'unset')]);
    })();

    await wrap(() => ({}), async () => {
      setDb(tenantB);
      await s2c.pushActive('taggedItems', [taggedItem('rec-2', 'unset')]);
    })();

    expect(emitted).toHaveLength(2);
    expect(emitted[0]![0]!.records[0]).toEqual(
      expect.objectContaining({ record: expect.objectContaining({ source: 'tenant-a' }) }),
    );
    expect(emitted[1]![0]!.records[0]).toEqual(
      expect.objectContaining({ record: expect.objectContaining({ source: 'tenant-b' }) }),
    );
  });
});
