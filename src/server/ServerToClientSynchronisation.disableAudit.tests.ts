import { describe, it, expect, beforeEach } from 'vitest';
import '@anupheaus/common'; // installs array extensions (.ids()) and Object.clone used by the sync engine
import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import { auditor, defineCollection } from '../common';
import type { AuditEntry } from '../common/auditor';
import {
  ClientReceiver,
  type MXDBRecordStatesRequest,
  type MXDBRecordStates,
  type MXDBUpdateRequest,
  type MXDBSyncEngineResponse,
  type MXDBRecordCursors,
} from '../common/sync-engine';
import { ServerToClientSynchronisation } from './ServerToClientSynchronisation';
import type { ServerDb } from './providers/db/ServerDb';

/**
 * Integration regression for server→client propagation on a `disableAudit` collection.
 *
 * Non-audited collections carry NO audit ULID, so every cursor the server emits has an
 * empty `lastAuditEntryId`. This previously froze clients on the first synced version: the
 * client anchored the record to a random branch ULID (`'' || ulid()` in DbCollection), and
 * every later empty-anchor update was discarded by the ClientReceiver staleness guard as
 * "older than the local branch". A server-driven status field (e.g. a job moving
 * queued → working → complete) would never advance past its first value on the client.
 *
 * This wires the REAL ServerToClientSynchronisation (the component that emits the empty
 * anchors) through its real ServerDispatcher to a REAL ClientReceiver, with a fake ServerDb
 * and a client store that mirrors DbCollection.applyServerWriteSync. It exercises the exact
 * path the user reported: a record updated ON THE SERVER must reach a subscribed client.
 */

interface NoAuditItem extends MXDBRecord {
  id: string;
  status: string;
}

const noAuditCollection = defineCollection<NoAuditItem>({
  name: 'noAuditItems',
  indexes: [],
  disableAudit: true,
});

/** A logger stub that also satisfies the `createSubLogger` call in the SD constructor. */
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

interface ClientStoreEntry {
  record: NoAuditItem;
  audit: AuditEntry[];
}

interface Harness {
  s2c: ServerToClientSynchronisation;
  serverStore: Map<string, NoAuditItem>;
  clientStore: Map<string, ClientStoreEntry>;
  /** Set the live server record and fan it out as a change-stream upsert (a server-side write). */
  serverUpdate(record: NoAuditItem): Promise<void>;
  /** Authoritatively push a record to the client (getAll / subscription / get path). */
  serverPushActive(record: NoAuditItem): Promise<void>;
  /** Resolve once the client's stored record reaches `status`, or throw after a bounded wait. */
  waitForClientStatus(id: string, status: string): Promise<void>;
}

function createHarness(): Harness {
  const serverStore = new Map<string, NoAuditItem>();
  const clientStore = new Map<string, ClientStoreEntry>();

  // Fake ServerDb: the disableAudit path only ever calls `collection.get(ids)`.
  const fakeDb = {
    use(_collectionName: string) {
      return {
        async get(ids: string[]): Promise<NoAuditItem[]> {
          return ids.map(id => serverStore.get(id)).filter((record): record is NoAuditItem => record != null);
        },
      };
    },
  } as unknown as ServerDb;

  // Generic to match ClientReceiverProps.onRetrieve; the store is single-collection so each
  // stored record is cast to the caller's requested element type.
  const onRetrieve = <T extends MXDBRecord>(request: MXDBRecordStatesRequest): MXDBRecordStates<T> =>
    request.map(({ collectionName, recordIds }) => ({
      collectionName,
      records: recordIds.flatMap(id => {
        const entry = clientStore.get(id);
        return entry == null ? [] : [{ record: entry.record as unknown as T, audit: entry.audit }];
      }),
    }));

  // Mirrors DbCollection.applyServerWriteSync for a non-audited collection: store the record
  // and anchor it to a fresh branch (`lastAuditEntryId || ulid()`), with no pending changes.
  const onUpdate = (updates: MXDBUpdateRequest): MXDBSyncEngineResponse =>
    updates.map(({ collectionName, records, deletedRecordIds }) => {
      const successfulRecordIds: string[] = [];
      for (const { record, lastAuditEntryId } of records ?? []) {
        const branchedAudit = auditor.createBranchFrom<NoAuditItem>(record.id, lastAuditEntryId || auditor.generateUlid());
        clientStore.set(record.id, { record: record as NoAuditItem, audit: branchedAudit.entries });
        successfulRecordIds.push(record.id);
      }
      for (const id of deletedRecordIds ?? []) {
        clientStore.delete(id);
        successfulRecordIds.push(id);
      }
      return { collectionName, successfulRecordIds };
    });

  const clientReceiver = new ClientReceiver(makeLogger(), { onRetrieve, onUpdate });

  const s2c = new ServerToClientSynchronisation({
    emitS2C: async (payload: MXDBRecordCursors) => clientReceiver.process(payload),
    getDb: () => fakeDb,
    collections: [noAuditCollection],
    logger: makeLogger(),
    clientId: 'test-client',
  });

  // The dispatch pipeline is fully in-process and timer-free (emitS2C resolves a microtask),
  // so draining the microtask queue is deterministic — no real timers, no flakiness.
  const waitForClientStatus = async (id: string, status: string): Promise<void> => {
    for (let tick = 0; tick < 500; tick++) {
      if (clientStore.get(id)?.record.status === status) return;
      await Promise.resolve();
    }
    throw new Error(`client record "${id}" never reached status "${status}" (got "${clientStore.get(id)?.record.status ?? 'undefined'}")`);
  };

  return {
    s2c,
    serverStore,
    clientStore,
    serverPushActive: async record => {
      serverStore.set(record.id, record);
      await s2c.pushActive(noAuditCollection.name, [record]);
    },
    serverUpdate: async record => {
      serverStore.set(record.id, record);
      await s2c.onDbChange({ type: 'upsert', collectionName: noAuditCollection.name, records: [record] });
    },
    waitForClientStatus,
  };
}

describe('ServerToClientSynchronisation — disableAudit server-side updates', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('propagates an authoritative push of a non-audited record to the client', async () => {
    await harness.serverPushActive({ id: 'job-1', status: 'queued' });

    await harness.waitForClientStatus('job-1', 'queued');
    expect(harness.clientStore.get('job-1')?.record.status).toBe('queued');
  });

  it('propagates a server-side update of a non-audited record the client already has', async () => {
    await harness.serverPushActive({ id: 'job-1', status: 'queued' });
    await harness.waitForClientStatus('job-1', 'queued');

    // Updated ON THE SERVER (no client involvement) — fans out via the change stream.
    await harness.serverUpdate({ id: 'job-1', status: 'working' });

    // Before the fix this hung forever: the empty-anchor cursor was dropped as "stale".
    await harness.waitForClientStatus('job-1', 'working');
    expect(harness.clientStore.get('job-1')?.record.status).toBe('working');
  });

  it('keeps flushing successive server-side updates — the record is never frozen on its first version', async () => {
    await harness.serverPushActive({ id: 'job-1', status: 'queued' });
    await harness.waitForClientStatus('job-1', 'queued');

    // A server-driven status field advancing through several values, each a separate server write.
    const progression = ['working', 'step-2', 'step-3', 'complete'];
    for (const status of progression) {
      await harness.serverUpdate({ id: 'job-1', status });
      await harness.waitForClientStatus('job-1', status);
      expect(harness.clientStore.get('job-1')?.record.status).toBe(status);
    }

    expect(harness.clientStore.get('job-1')?.record.status).toBe('complete');
  });

  it('does not push a change-stream update for a record the client never subscribed to', async () => {
    // No authoritative push first → the record is not in the SD filter, so change-stream
    // fan-out must not bootstrap it onto the client (addToFilter=false is dropped).
    await harness.serverUpdate({ id: 'job-unknown', status: 'working' });

    // Give the pipeline a chance to (incorrectly) deliver it.
    for (let tick = 0; tick < 50; tick++) await Promise.resolve();
    expect(harness.clientStore.has('job-unknown')).toBe(false);
  });
});
