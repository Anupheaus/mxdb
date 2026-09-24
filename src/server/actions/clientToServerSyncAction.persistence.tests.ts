import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { monotonicFactory } from 'ulidx';
import '@anupheaus/common'; // installs array extensions (.ids()) and Object.clone used by the sync engine
import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import { AuditEntryType, OperationType, auditor, defineCollection, type MXDBCollection } from '../../common';
import type { AuditEntry, AuditOf } from '../../common/auditor';
import { hashRecord } from '../../common/auditor/hash';
import type { ClientDispatcherRequest, MXDBRecordCursors, MXDBSyncEngineResponse } from '../../common/sync-engine';
import { ServerToClientSynchronisation } from '../ServerToClientSynchronisation';
import { extendCollection, type OnDeletePayload, type OnUpsertPayload } from '../collections/extendCollection';

/**
 * End-to-end contract of the C2S sync handler with the REAL ServerReceiver, ServerDispatcher and
 * ServerToClientSynchronisation. Only the external boundaries are stubbed: MongoDB (a fake
 * collection that really stores what `sync` writes), the socket emit back to the client, and the
 * nexus request context (`useDb` / `useLogger` / the per-socket S2C instance).
 *
 * Complements `clientToServerSyncAction.tests.ts`, which isolates the handler from the receiver.
 */

const ctx = vi.hoisted(() => ({
  db: undefined as unknown,
  s2c: undefined as unknown,
  logger: undefined as unknown,
}));

vi.mock('../providers', () => ({
  useDb: () => ctx.db,
  useServerToClientSynchronisation: () => ctx.s2c,
}));

vi.mock('@anupheaus/nexus/server', () => ({
  createServerActionHandler: (_def: unknown, handler: unknown) => handler,
  useLogger: () => ctx.logger,
}));

import { handleClientToServerSync } from './clientToServerSyncAction';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

interface Item extends MXDBRecord {
  id: string;
  name?: string;
  colour?: string;
}

const ITEMS = 'c2sPersistenceItems';
const UNKNOWN = 'c2sNotOnThisServer';
const itemsCollection = defineCollection<Item>({ name: ITEMS, indexes: [] });

function entryId(sequence: number): string {
  return `01J${String(sequence).padStart(23, '0')}`;
}

function createdEntry(record: Item, sequence: number): AuditEntry {
  return { type: AuditEntryType.Created, id: entryId(sequence), record: { ...record } } as AuditEntry;
}

function branchedEntry(sequence: number): AuditEntry {
  return { type: AuditEntryType.Branched, id: entryId(sequence) } as AuditEntry;
}

function replaceEntry(sequence: number, field: 'name' | 'colour', value: string): AuditEntry {
  return { type: AuditEntryType.Updated, id: entryId(sequence), ops: [{ type: OperationType.Replace, path: field, value }] } as AuditEntry;
}

function deletedEntry(sequence: number): AuditEntry {
  return { type: AuditEntryType.Deleted, id: entryId(sequence) } as AuditEntry;
}

function request(collectionName: string, id: string, entries: AuditEntry[], hash?: string): ClientDispatcherRequest {
  return [{ collectionName, records: [{ id, hash, entries }] }];
}

interface MockLogger {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  silly: ReturnType<typeof vi.fn>;
  createSubLogger: ReturnType<typeof vi.fn>;
}

function createMockLogger(): MockLogger {
  const logger: MockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn(), createSubLogger: vi.fn() };
  logger.createSubLogger.mockReturnValue(logger);
  return logger;
}

// ─── Fake MongoDB collection that really persists `sync` writes ──────────────

interface SyncWriteResult { id: string; error?: unknown }
interface SyncProps { updated: Item[]; updatedAudits: AuditOf<Item>[]; removedIds: string[] }

interface FakeCollection {
  collection: MXDBCollection<Item>;
  records: Map<string, Item>;
  audits: Map<string, AuditOf<Item>>;
  /** Stored `_meta.hash` per id (what `getMeta` projects). */
  metaHashes: Map<string, string>;
  get: ReturnType<typeof vi.fn<(ids: string[]) => Promise<Item[]>>>;
  getAudit: ReturnType<typeof vi.fn<(ids: string | string[]) => Promise<AuditOf<Item>[] | AuditOf<Item> | undefined>>>;
  getMeta: ReturnType<typeof vi.fn<(ids: string[]) => Promise<{ id: string; hash: string }[]>>>;
  sync: ReturnType<typeof vi.fn<(props: SyncProps) => Promise<SyncWriteResult[]>>>;
}

function createFakeCollection(definition: MXDBCollection<Item>): FakeCollection {
  const records = new Map<string, Item>();
  const audits = new Map<string, AuditOf<Item>>();
  const metaHashes = new Map<string, string>();
  const readAudit = (id: string) => {
    const audit = audits.get(id);
    return audit == null ? undefined : { id, entries: [...audit.entries] } as AuditOf<Item>;
  };
  return {
    collection: definition, records, audits, metaHashes,
    get: vi.fn(async (ids: string[]) => ids.map(id => records.get(id)).filter((r): r is Item => r != null).map(r => ({ ...r }))),
    getAudit: vi.fn(async (ids: string | string[]) => (Array.isArray(ids)
      ? ids.map(readAudit).filter((a): a is AuditOf<Item> => a != null)
      : readAudit(ids))),
    getMeta: vi.fn(async (ids: string[]) => ids.flatMap(id => {
      const hash = metaHashes.get(id);
      return hash == null ? [] : [{ id, hash }];
    })),
    sync: vi.fn(async ({ updated, updatedAudits, removedIds }: SyncProps) => {
      for (const audit of updatedAudits) audits.set(audit.id, { id: audit.id, entries: [...audit.entries] } as AuditOf<Item>);
      for (const record of updated) records.set(record.id, { ...record });
      for (const id of removedIds) records.delete(id);
      return [...updated.map(r => ({ id: r.id })), ...removedIds.map(id => ({ id }))];
    }),
  };
}

// ─── Harness ───────────────────────────────────────────────────────────────────

interface Harness {
  collection: FakeCollection;
  logger: MockLogger;
  /** Payloads the server pushed back to this client. */
  emitted: MXDBRecordCursors[];
  seed(record: Item, entries: AuditEntry[]): void;
}

interface HarnessOptions {
  /** Make `db.use` throw instead of returning undefined for an unknown collection. */
  useThrows?: boolean;
  /** The collection the fake db serves (default: the un-hooked items collection). */
  definition?: MXDBCollection<Item>;
}

function installHarness({ useThrows = false, definition = itemsCollection }: HarnessOptions = {}): Harness {
  const collection = createFakeCollection(definition);
  const logger = createMockLogger();
  const emitted: MXDBRecordCursors[] = [];
  const db = {
    use: (name: string) => {
      if (useThrows) throw new Error(`collection "${name}" not registered`);
      return name === definition.name ? collection : undefined;
    },
  };
  ctx.db = db;
  ctx.logger = logger;
  ctx.s2c = new ServerToClientSynchronisation({
    emitS2C: async (payload): Promise<MXDBSyncEngineResponse> => {
      emitted.push(structuredClone(payload));
      return payload.map(({ collectionName, records }) => ({
        collectionName,
        successfulRecordIds: records.map(cursor => ('recordId' in cursor ? cursor.recordId : cursor.record.id)),
      }));
    },
    getDb: () => db as never,
    collections: [definition],
    logger: logger as unknown as Logger,
    clientId: 'client-1',
  });
  return {
    collection, logger, emitted,
    seed: (record, entries) => {
      collection.records.set(record.id, { ...record });
      collection.audits.set(record.id, { id: record.id, entries } as AuditOf<Item>);
    },
  };
}

// ─── Persisting client changes ────────────────────────────────────────────────

describe('handleClientToServerSync — persisting client changes', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = installHarness();
  });

  it('persists a record the client created and acknowledges it', async () => {
    const record: Item = { id: 'i1', name: 'new' };

    const response = await handleClientToServerSync(request(ITEMS, 'i1', [createdEntry(record, 1)], await hashRecord(record)));

    expect(response).toEqual([{ collectionName: ITEMS, successfulRecordIds: ['i1'] }]);
    expect(harness.collection.records.get('i1')).toEqual(record);
  });

  it('stores the client audit entries for a created record', async () => {
    const record: Item = { id: 'i1', name: 'new' };

    await handleClientToServerSync(request(ITEMS, 'i1', [createdEntry(record, 1)], await hashRecord(record)));

    expect(harness.collection.audits.get('i1')!.entries.map(entry => entry.id)).toEqual([entryId(1)]);
  });

  it('merges a client update into the existing server audit and persists the replayed record', async () => {
    harness.seed({ id: 'i1', name: 'old' }, [createdEntry({ id: 'i1', name: 'old' }, 1)]);

    await handleClientToServerSync(request(ITEMS, 'i1', [branchedEntry(1), replaceEntry(2, 'name', 'renamed')], 'client-hash'));

    expect(harness.collection.records.get('i1')).toEqual({ id: 'i1', name: 'renamed' });
    expect(harness.collection.audits.get('i1')!.entries.map(entry => entry.id)).toEqual([entryId(1), entryId(2)]);
  });

  it('removes the live record when the client deletes it, keeping the full audit trail', async () => {
    harness.seed({ id: 'i1', name: 'old' }, [createdEntry({ id: 'i1', name: 'old' }, 1)]);

    const response = await handleClientToServerSync(request(ITEMS, 'i1', [branchedEntry(1), deletedEntry(2)]));

    expect(response).toEqual([{ collectionName: ITEMS, successfulRecordIds: ['i1'] }]);
    expect(harness.collection.records.has('i1')).toBe(false);
    expect(harness.collection.audits.get('i1')!.entries.map(entry => entry.type)).toEqual([AuditEntryType.Created, AuditEntryType.Deleted]);
  });

  it('sends the merged record back to the client when it differs from what the client holds', async () => {
    harness.seed({ id: 'i1', name: 'old', colour: 'red' }, [createdEntry({ id: 'i1', name: 'old', colour: 'red' }, 1)]);

    await handleClientToServerSync(request(ITEMS, 'i1', [branchedEntry(1), replaceEntry(2, 'name', 'renamed')], 'stale-client-hash'));

    const merged: Item = { id: 'i1', name: 'renamed', colour: 'red' };
    expect(harness.emitted).toEqual([[{
      collectionName: ITEMS,
      records: [{ record: merged, lastAuditEntryId: entryId(2), hash: await hashRecord(merged) }],
    }]]);
  });

  it('tells the client to delete a record whose audit is live but whose document is missing (split-brain guard)', async () => {
    harness.collection.audits.set('i1', { id: 'i1', entries: [createdEntry({ id: 'i1', name: 'lost' }, 1)] } as AuditOf<Item>);

    await handleClientToServerSync(request(ITEMS, 'i1', [branchedEntry(1)], 'client-hash'));

    expect(harness.emitted).toEqual([[{ collectionName: ITEMS, records: [{ recordId: 'i1', lastAuditEntryId: entryId(1) }] }]]);
  });

  it('treats a live record with no audit (non-audited collection data) as existing rather than deleted', async () => {
    const record: Item = { id: 'i1', name: 'plain' };
    harness.collection.records.set('i1', record);

    await handleClientToServerSync(request(ITEMS, 'i1', [branchedEntry(1)], await hashRecord(record)));

    expect(harness.emitted).toEqual([]);
  });
});

// ─── Collection before-write hooks ────────────────────────────────────────────

const hookedItemsCollection = defineCollection<Item>({ name: 'c2sHookedItems', indexes: [] });
/** How far ahead of the server a skewed client's clock runs in the clock-skew scenarios. */
const CLIENT_CLOCK_AHEAD_MS = 3_600_000;
const HOOKED = hookedItemsCollection.name;

// The extension registry cannot be cleared, so the collection's hooks delegate to per-test implementations.
const hooks = {
  onBeforeUpsert: vi.fn<(payload: OnUpsertPayload<Item>) => Promise<void>>(),
  onBeforeDelete: vi.fn<(payload: OnDeletePayload) => Promise<void>>(),
};
extendCollection(hookedItemsCollection, {
  onBeforeUpsert: payload => hooks.onBeforeUpsert(payload),
  onBeforeDelete: payload => hooks.onBeforeDelete(payload),
});

describe('handleClientToServerSync — collection before-write hooks', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = installHarness({ definition: hookedItemsCollection });
    hooks.onBeforeUpsert.mockReset().mockResolvedValue(undefined);
    hooks.onBeforeDelete.mockReset().mockResolvedValue(undefined);
  });

  /** A hook in the shape consumers write: amend the changing records in place (a rename resets the colour). */
  const resetColourOnRename = (): void => {
    hooks.onBeforeUpsert.mockImplementation(async ({ records }) => {
      for (const record of records) {
        if (harness.collection.records.get(record.id)?.name !== record.name) record.colour = 'unset';
      }
    });
  };

  const renamedByClient: Item = { id: 'i1', name: 'renamed', colour: 'red' };
  const amendedByHook: Item = { id: 'i1', name: 'renamed', colour: 'unset' };

  /** Seeds `{ name: 'old', colour: 'red' }` and syncs the client's rename of it, claiming the client's own hash. */
  const syncClientRename = async (): Promise<MXDBSyncEngineResponse> => {
    harness.seed({ id: 'i1', name: 'old', colour: 'red' }, [createdEntry({ id: 'i1', name: 'old', colour: 'red' }, 1)]);
    return handleClientToServerSync(request(HOOKED, 'i1', [branchedEntry(1), replaceEntry(2, 'name', 'renamed')], await hashRecord(renamedByClient)));
  };

  it('runs onBeforeUpsert for a record the client created, before it is persisted', async () => {
    let wasStoredWhileHookRan: boolean | undefined;
    hooks.onBeforeUpsert.mockImplementation(async () => { wasStoredWhileHookRan = harness.collection.records.has('i1'); });

    await handleClientToServerSync(request(HOOKED, 'i1', [createdEntry({ id: 'i1', name: 'new' }, 1)], 'client-hash'));

    expect([wasStoredWhileHookRan, hooks.onBeforeUpsert.mock.calls]).toEqual([
      false,
      [[{ records: [{ id: 'i1', name: 'new' }], insertedIds: ['i1'], updatedIds: [] }]],
    ]);
  });

  it('runs onBeforeUpsert once with the merged record for a client update', async () => {
    await syncClientRename();

    expect(hooks.onBeforeUpsert.mock.calls).toEqual([[{ records: [renamedByClient], insertedIds: [], updatedIds: ['i1'] }]]);
  });

  it('persists the record as amended by onBeforeUpsert', async () => {
    resetColourOnRename();

    await syncClientRename();

    expect(harness.collection.records.get('i1')).toEqual(amendedByHook);
  });

  it('records the amendment in the audit, so the audit replays to the persisted record', async () => {
    resetColourOnRename();

    await syncClientRename();

    expect(auditor.createRecordFrom(harness.collection.audits.get('i1')!)).toEqual(amendedByHook);
  });

  it('keeps the client\'s audit entries when the hook amends the record', async () => {
    resetColourOnRename();

    await syncClientRename();

    expect(harness.collection.audits.get('i1')!.entries.map(entry => entry.type))
      .toEqual([AuditEntryType.Created, AuditEntryType.Updated, AuditEntryType.Updated]);
  });

  it('sends the amended record back to the client that made the change', async () => {
    resetColourOnRename();

    await syncClientRename();

    const lastAuditEntryId = harness.collection.audits.get('i1')!.entries.at(-1)!.id;
    expect(harness.emitted).toEqual([[{
      collectionName: HOOKED,
      records: [{ record: amendedByHook, lastAuditEntryId, hash: await hashRecord(amendedByHook) }],
    }]]);
  });

  it('orders the amendment after the client\'s change even when the client\'s clock runs ahead', async () => {
    resetColourOnRename();
    harness.seed({ id: 'i1', name: 'old', colour: 'red' }, [createdEntry({ id: 'i1', name: 'old', colour: 'red' }, 1)]);
    const aheadOfServerClock = monotonicFactory()(Date.now() + CLIENT_CLOCK_AHEAD_MS);
    const clientRename = { type: AuditEntryType.Updated, id: aheadOfServerClock, ops: [{ type: OperationType.Replace, path: 'name', value: 'renamed' }] } as AuditEntry;

    await handleClientToServerSync(request(HOOKED, 'i1', [branchedEntry(1), clientRename], await hashRecord(renamedByClient)));

    const storedAudit = harness.collection.audits.get('i1')!;
    expect([storedAudit.entries.at(-1)!.id > aheadOfServerClock, auditor.createRecordFrom(storedAudit)]).toEqual([true, amendedByHook]);
  });

  it('acknowledges the change as usual when the hook leaves the record alone', async () => {
    const response = await syncClientRename();

    expect([response, harness.emitted]).toEqual([[{ collectionName: HOOKED, successfulRecordIds: ['i1'] }], []]);
  });

  it('does not run onBeforeUpsert again when the client re-sends a change the server already has', async () => {
    harness.seed(renamedByClient, [createdEntry({ id: 'i1', name: 'old', colour: 'red' }, 1), replaceEntry(2, 'name', 'renamed')]);

    await handleClientToServerSync(request(HOOKED, 'i1', [branchedEntry(1), replaceEntry(2, 'name', 'renamed')], await hashRecord(renamedByClient)));

    expect(hooks.onBeforeUpsert).not.toHaveBeenCalled();
  });

  it('runs onBeforeDelete for a record the client deleted, while it is still stored', async () => {
    harness.seed({ id: 'i1', name: 'old' }, [createdEntry({ id: 'i1', name: 'old' }, 1)]);
    let wasStoredWhileHookRan: boolean | undefined;
    hooks.onBeforeDelete.mockImplementation(async () => { wasStoredWhileHookRan = harness.collection.records.has('i1'); });

    await handleClientToServerSync(request(HOOKED, 'i1', [branchedEntry(1), deletedEntry(2)]));

    expect([wasStoredWhileHookRan, hooks.onBeforeDelete.mock.calls]).toEqual([true, [[{ recordIds: ['i1'] }]]]);
  });

  it('does not run onBeforeDelete for a record the server has already deleted', async () => {
    harness.collection.audits.set('i1', { id: 'i1', entries: [createdEntry({ id: 'i1', name: 'old' }, 1), deletedEntry(2)] } as AuditOf<Item>);

    await handleClientToServerSync(request(HOOKED, 'i1', [branchedEntry(1), replaceEntry(3, 'name', 'late edit')], 'client-hash'));

    expect(hooks.onBeforeDelete).not.toHaveBeenCalled();
  });

  it('runs onBeforeUpsert separately for each record in a client batch', async () => {
    await handleClientToServerSync([{
      collectionName: HOOKED,
      records: [
        { id: 'i1', hash: 'h1', entries: [createdEntry({ id: 'i1', name: 'a' }, 1)] },
        { id: 'i2', hash: 'h2', entries: [createdEntry({ id: 'i2', name: 'b' }, 2)] },
      ],
    }]);

    expect(hooks.onBeforeUpsert.mock.calls.map(([payload]) => payload.records.ids())).toEqual([['i1'], ['i2']]);
  });
});

// ─── Before-write hook rejections (reject and revert) ─────────────────────────

describe('handleClientToServerSync — a before-write hook rejects a synced record', () => {
  let harness: Harness;
  const REJECTION = 'the name "forbidden" is not allowed';
  const stored: Item = { id: 'i1', name: 'old', colour: 'red' };
  const forbiddenRename: Item = { ...stored, name: 'forbidden' };
  const forbiddenCreate: Item = { id: 'n1', name: 'forbidden' };

  beforeEach(() => {
    harness = installHarness({ definition: hookedItemsCollection });
    hooks.onBeforeUpsert.mockReset().mockImplementation(async ({ records }) => {
      if (records.some(record => record.name === 'forbidden')) throw new Error(REJECTION);
    });
    hooks.onBeforeDelete.mockReset().mockResolvedValue(undefined);
  });

  /** Seeds {@link stored} and syncs the client's rename of it to "forbidden". */
  const syncRejectedUpdate = async (renameEntry: AuditEntry = replaceEntry(2, 'name', 'forbidden')): Promise<MXDBSyncEngineResponse> => {
    harness.seed(stored, [createdEntry(stored, 1)]);
    return handleClientToServerSync(request(HOOKED, 'i1', [branchedEntry(1), renameEntry], await hashRecord(forbiddenRename)));
  };

  const syncRejectedCreate = async (): Promise<MXDBSyncEngineResponse> =>
    handleClientToServerSync(request(HOOKED, 'n1', [createdEntry(forbiddenCreate, 5)], await hashRecord(forbiddenCreate)));

  const syncRejectedDelete = async (): Promise<MXDBSyncEngineResponse> => {
    harness.seed(stored, [createdEntry(stored, 1)]);
    hooks.onBeforeDelete.mockRejectedValue(new Error('still referenced'));
    return handleClientToServerSync(request(HOOKED, 'i1', [branchedEntry(1), deletedEntry(2)]));
  };

  describe('an update', () => {
    it('is acknowledged and reported as rejected with the hook\'s reason, so the client stops resending it', async () => {
      const response = await syncRejectedUpdate();

      expect(response).toEqual([{ collectionName: HOOKED, successfulRecordIds: ['i1'], rejectedRecords: [{ id: 'i1', reason: REJECTION }] }]);
    });

    it('leaves the stored record as it was', async () => {
      await syncRejectedUpdate();

      expect(harness.collection.records.get('i1')).toEqual(stored);
    });

    it('keeps the client\'s entry in the audit and reverts it, so the audit replays to the stored record', async () => {
      await syncRejectedUpdate();

      const audit = harness.collection.audits.get('i1')!;
      expect([audit.entries.map(entry => entry.id).slice(0, 2), audit.entries.length, auditor.createRecordFrom(audit)])
        .toEqual([[entryId(1), entryId(2)], 3, stored]);
    });

    it('sends the stored record back to the client so it reverts its change', async () => {
      await syncRejectedUpdate();

      const lastAuditEntryId = harness.collection.audits.get('i1')!.entries.at(-1)!.id;
      expect(harness.emitted).toEqual([[{ collectionName: HOOKED, records: [{ record: stored, lastAuditEntryId, hash: await hashRecord(stored) }] }]]);
    });

    it('orders the revert after the client\'s change even when the client\'s clock runs ahead', async () => {
      const aheadOfServerClock = monotonicFactory()(Date.now() + CLIENT_CLOCK_AHEAD_MS);

      await syncRejectedUpdate({ type: AuditEntryType.Updated, id: aheadOfServerClock, ops: [{ type: OperationType.Replace, path: 'name', value: 'forbidden' }] } as AuditEntry);

      const audit = harness.collection.audits.get('i1')!;
      expect([audit.entries.at(-1)!.id > aheadOfServerClock, auditor.createRecordFrom(audit)]).toEqual([true, stored]);
    });

    it('does not reject again once the client has reverted', async () => {
      await syncRejectedUpdate();
      const revertId = harness.collection.audits.get('i1')!.entries.at(-1)!.id;
      hooks.onBeforeUpsert.mockClear();

      const response = await handleClientToServerSync(request(HOOKED, 'i1', [branchedEntry(1)], await hashRecord(stored)));

      expect([response, hooks.onBeforeUpsert.mock.calls.length, harness.collection.audits.get('i1')!.entries.at(-1)!.id])
        .toEqual([[{ collectionName: HOOKED, successfulRecordIds: ['i1'] }], 0, revertId]);
    });
  });

  describe('a create', () => {
    it('is acknowledged and reported as rejected', async () => {
      const response = await syncRejectedCreate();

      expect(response).toEqual([{ collectionName: HOOKED, successfulRecordIds: ['n1'], rejectedRecords: [{ id: 'n1', reason: REJECTION }] }]);
    });

    it('is recorded as deleted, keeping the client\'s entry, and never stored live', async () => {
      await syncRejectedCreate();

      expect([harness.collection.records.has('n1'), harness.collection.audits.get('n1')!.entries.map(entry => entry.type)])
        .toEqual([false, [AuditEntryType.Created, AuditEntryType.Deleted]]);
    });

    it('tells the client to delete the record it created', async () => {
      await syncRejectedCreate();

      const lastAuditEntryId = harness.collection.audits.get('n1')!.entries.at(-1)!.id;
      expect(harness.emitted).toEqual([[{ collectionName: HOOKED, records: [{ recordId: 'n1', lastAuditEntryId }] }]]);
    });
  });

  describe('a delete', () => {
    it('is acknowledged and reported as rejected', async () => {
      const response = await syncRejectedDelete();

      expect(response).toEqual([{ collectionName: HOOKED, successfulRecordIds: ['i1'], rejectedRecords: [{ id: 'i1', reason: 'still referenced' }] }]);
    });

    it('leaves the record and its audit on the server untouched', async () => {
      await syncRejectedDelete();

      expect([harness.collection.records.get('i1'), harness.collection.audits.get('i1')!.entries.map(entry => entry.id)])
        .toEqual([stored, [entryId(1)]]);
    });

    it('sends nothing back (the device keeps its delete)', async () => {
      await syncRejectedDelete();

      expect(harness.emitted).toEqual([]);
    });
  });

  it('persists and acknowledges the rest of the batch', async () => {
    const accepted: Item = { id: 'ok', name: 'fine' };

    const response = await handleClientToServerSync([{
      collectionName: HOOKED,
      records: [
        { id: 'n1', hash: 'h1', entries: [createdEntry({ id: 'n1', name: 'forbidden' }, 1)] },
        { id: 'ok', hash: await hashRecord(accepted), entries: [createdEntry(accepted, 2)] },
      ],
    }]);

    expect([response, harness.collection.records.get('ok')]).toEqual([
      [{ collectionName: HOOKED, successfulRecordIds: ['n1', 'ok'], rejectedRecords: [{ id: 'n1', reason: REJECTION }] }],
      accepted,
    ]);
  });

  const thrownValues: Array<[string, unknown, string]> = [
    ['an Error', new Error('nope'), 'nope'],
    ['a string', 'plain refusal', 'plain refusal'],
    ['an object', { code: 42 }, '{"code":42}'],
  ];

  it.each(thrownValues)('reports %s thrown by the hook as the reason', async (_label, thrown, reason) => {
    hooks.onBeforeUpsert.mockRejectedValue(thrown);

    const response = await syncRejectedCreate();

    expect(response[0]!.rejectedRecords).toEqual([{ id: 'n1', reason }]);
  });

  it('logs the rejection', async () => {
    await syncRejectedCreate();

    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('rejected'), expect.objectContaining({ collectionName: HOOKED, recordId: 'n1', reason: REJECTION }));
  });
});

// ─── Write failures ────────────────────────────────────────────────────────────

describe('handleClientToServerSync — write failures', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = installHarness();
  });

  const writeFailures: Array<[string, unknown, 'warn' | 'error']> = [
    ['a transient Mongo close error', Object.assign(new Error('client was closed'), { name: 'MongoClientClosedError' }), 'warn'],
    ['a permanent I/O error', new Error('document too large'), 'error'],
  ];

  it.each(writeFailures)('does not acknowledge a record whose write failed with %s', async (_label, failure) => {
    harness.collection.sync.mockResolvedValueOnce([{ id: 'i1', error: failure }, { id: 'i2' }]);

    const response = await handleClientToServerSync([{
      collectionName: ITEMS,
      records: [
        { id: 'i1', hash: 'h1', entries: [createdEntry({ id: 'i1', name: 'a' }, 1)] },
        { id: 'i2', hash: 'h2', entries: [createdEntry({ id: 'i2', name: 'b' }, 2)] },
      ],
    }]);

    expect(response).toEqual([{ collectionName: ITEMS, successfulRecordIds: ['i2'] }]);
  });

  it.each(writeFailures)('logs a per-record write failure caused by %s at %s level', async (_label, failure, level) => {
    harness.collection.sync.mockResolvedValueOnce([{ id: 'i1', error: failure }]);

    await handleClientToServerSync(request(ITEMS, 'i1', [createdEntry({ id: 'i1', name: 'a' }, 1)], 'h1'));

    expect(harness.logger[level]).toHaveBeenCalledWith(expect.stringContaining('"i1"'), { error: failure });
  });

  it.each(writeFailures)('acknowledges nothing when the whole collection write throws %s, so the client retries', async (_label, failure) => {
    harness.collection.sync.mockRejectedValueOnce(failure);

    const response = await handleClientToServerSync(request(ITEMS, 'i1', [createdEntry({ id: 'i1', name: 'a' }, 1)], 'h1'));

    expect(response).toEqual([{ collectionName: ITEMS, successfulRecordIds: [] }]);
  });

  it.each(writeFailures)('logs a whole-collection write failure caused by %s at %s level', async (_label, failure, level) => {
    harness.collection.sync.mockRejectedValueOnce(failure);

    await handleClientToServerSync(request(ITEMS, 'i1', [createdEntry({ id: 'i1', name: 'a' }, 1)], 'h1'));

    expect(harness.logger[level]).toHaveBeenCalledWith(expect.stringContaining(`"${ITEMS}"`), { error: failure });
  });
});

// ─── Read failures ─────────────────────────────────────────────────────────────

describe('handleClientToServerSync — read failures', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = installHarness();
  });

  it('returns an empty response (client retries) when the read is aborted by a Mongo client close', async () => {
    harness.collection.getAudit.mockRejectedValueOnce(Object.assign(new Error('Client must be connected'), { name: 'MongoNotConnectedError' }));

    const response = await handleClientToServerSync(request(ITEMS, 'i1', [createdEntry({ id: 'i1', name: 'a' }, 1)], 'h1'));

    expect(response).toEqual([]);
  });

  it('rejects rather than treating a failed read as "record does not exist"', async () => {
    harness.collection.getAudit.mockRejectedValueOnce(new Error('read timeout'));

    await expect(handleClientToServerSync(request(ITEMS, 'i1', [createdEntry({ id: 'i1', name: 'a' }, 1)], 'h1')))
      .rejects.toThrow('read timeout');
  });

  it('writes nothing when the read fails', async () => {
    harness.collection.getAudit.mockRejectedValueOnce(new Error('read timeout'));

    await handleClientToServerSync(request(ITEMS, 'i1', [createdEntry({ id: 'i1', name: 'a' }, 1)], 'h1')).catch(() => undefined);

    expect(harness.collection.sync).not.toHaveBeenCalled();
  });

  it('keeps pushing to the client after a failed sync (the dispatcher is resumed)', async () => {
    harness.collection.getAudit.mockRejectedValueOnce(new Error('read timeout'));
    await handleClientToServerSync(request(ITEMS, 'i1', [createdEntry({ id: 'i1', name: 'a' }, 1)], 'h1')).catch(() => undefined);
    const secondItem: Item = { id: 'i2', name: 'b' };
    harness.seed(secondItem, [createdEntry(secondItem, 2)]);

    await (ctx.s2c as ServerToClientSynchronisation).pushActive(ITEMS, [secondItem]);

    expect(harness.emitted).toHaveLength(1);
  });
});

// ─── Unknown collections ───────────────────────────────────────────────────────

describe('handleClientToServerSync — collections the server db does not register', () => {
  const dbVariants: Array<[string, boolean]> = [
    ['returns undefined', false],
    ['throws', true],
  ];

  it.each(dbVariants)('acknowledges nothing for a created record when db.use %s', async (_label, useThrows) => {
    installHarness({ useThrows });

    const response = await handleClientToServerSync(request(UNKNOWN, 'x1', [createdEntry({ id: 'x1', name: 'a' }, 1)], 'h1'));

    expect(response).toEqual([]);
  });

  it('warns that the collection is unknown', async () => {
    const harness = installHarness();

    await handleClientToServerSync(request(UNKNOWN, 'x1', [createdEntry({ id: 'x1', name: 'a' }, 1)], 'h1'));

    expect(harness.logger.warn).toHaveBeenCalledWith('C2S onRetrieve: unknown collection — skipping', { collectionName: UNKNOWN, recordCount: 1 });
  });

  it.each(dbVariants)('still answers a branched-only probe when db.use %s', async (_label, useThrows) => {
    installHarness({ useThrows });

    const response = await handleClientToServerSync(request(UNKNOWN, 'x1', [branchedEntry(1)], 'h1'));

    expect(response).toEqual([{ collectionName: UNKNOWN, successfulRecordIds: ['x1'] }]);
  });
});

// ─── Reconnect probes (meta fast-path) ────────────────────────────────────────

describe('handleClientToServerSync — branched-only reconnect probes', () => {
  let harness: Harness;
  const record: Item = { id: 'i1', name: 'same' };

  beforeEach(async () => {
    harness = installHarness();
    harness.seed(record, [createdEntry(record, 1)]);
    harness.collection.metaHashes.set('i1', await hashRecord(record));
  });

  it('acknowledges a probe whose hash matches the stored hash', async () => {
    const response = await handleClientToServerSync(request(ITEMS, 'i1', [branchedEntry(1)], await hashRecord(record)));

    expect(response).toEqual([{ collectionName: ITEMS, successfulRecordIds: ['i1'] }]);
  });

  it('sends nothing back for a probe that is already up to date', async () => {
    await handleClientToServerSync(request(ITEMS, 'i1', [branchedEntry(1)], await hashRecord(record)));

    expect(harness.emitted).toEqual([]);
  });

  it('sends the server record to a client whose probe hash is out of date', async () => {
    await handleClientToServerSync(request(ITEMS, 'i1', [branchedEntry(1)], 'out-of-date-hash'));

    expect(harness.emitted).toEqual([[{
      collectionName: ITEMS,
      records: [{ record, lastAuditEntryId: entryId(1), hash: await hashRecord(record) }],
    }]]);
  });
});

// ─── Concurrency ──────────────────────────────────────────────────────────────

describe('handleClientToServerSync — concurrent syncs for the same record', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = installHarness();
    harness.seed({ id: 'i1', name: 'base', colour: 'grey' }, [createdEntry({ id: 'i1', name: 'base', colour: 'grey' }, 1)]);
  });

  it('keeps both clients\' audit entries when two clients update the same record at once (no lost write)', async () => {
    await Promise.all([
      handleClientToServerSync(request(ITEMS, 'i1', [branchedEntry(1), replaceEntry(2, 'name', 'from-a')], 'hash-a')),
      handleClientToServerSync(request(ITEMS, 'i1', [branchedEntry(1), replaceEntry(3, 'colour', 'blue')], 'hash-b')),
    ]);

    expect(harness.collection.audits.get('i1')!.entries.map(entry => entry.id)).toEqual([entryId(1), entryId(2), entryId(3)]);
  });

  it('persists the combined record when two clients update different fields at once', async () => {
    await Promise.all([
      handleClientToServerSync(request(ITEMS, 'i1', [branchedEntry(1), replaceEntry(2, 'name', 'from-a')], 'hash-a')),
      handleClientToServerSync(request(ITEMS, 'i1', [branchedEntry(1), replaceEntry(3, 'colour', 'blue')], 'hash-b')),
    ]);

    expect(harness.collection.records.get('i1')).toEqual({ id: 'i1', name: 'from-a', colour: 'blue' });
  });

  it('does not make a branched-only probe wait behind an in-flight merge of the same record', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const realSync = harness.collection.sync.getMockImplementation()!;
    harness.collection.sync.mockImplementationOnce(async props => { await writeGate; return realSync(props); });
    const merge = handleClientToServerSync(request(ITEMS, 'i1', [branchedEntry(1), replaceEntry(2, 'name', 'slow')], 'hash-a'));

    const probe = await handleClientToServerSync(request(ITEMS, 'i1', [branchedEntry(1)], 'hash-b'));

    expect(probe).toEqual([{ collectionName: ITEMS, successfulRecordIds: ['i1'] }]);
    releaseWrite();
    await merge;
  });
});

// ─── Slow-read diagnostics ────────────────────────────────────────────────────

describe('handleClientToServerSync — slow read diagnostics', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] });
    harness = installHarness();
    harness.seed({ id: 'i1', name: 'a' }, [createdEntry({ id: 'i1', name: 'a' }, 1)]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Make the batched audit read take `ms` of (fake) wall-clock time. */
  const slowRead = (ms: number): void => {
    harness.collection.getAudit.mockImplementationOnce(async ids => {
      vi.advanceTimersByTime(ms);
      return Array.isArray(ids) ? [{ ...harness.collection.audits.get('i1')! }] : undefined;
    });
  };

  const readDurations: Array<[number, boolean, boolean]> = [
    // [ms, warns per-collection, warns total]
    [100, false, false],
    [499, false, false],
    [500, true, false],
    [1_000, true, true],
  ];

  it.each(readDurations)('for a %ims read: per-collection slow warning=%s, total slow warning=%s', async (ms, perCollection, total) => {
    slowRead(ms);

    await handleClientToServerSync(request(ITEMS, 'i1', [branchedEntry(1), replaceEntry(2, 'name', 'b')], 'h'));

    const warnedMessages = harness.logger.warn.mock.calls.map(([message]) => message);
    expect([warnedMessages.includes('[C2S] slow retrieve'), warnedMessages.includes('[C2S] slow retrieve total')]).toEqual([perCollection, total]);
  });
});
