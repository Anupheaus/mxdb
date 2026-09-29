import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ArgumentInvalidError, type DataFilters, type Logger, type Record } from '@anupheaus/common';
import { defineCollection } from '../common/defineCollection';
import type { DistinctRequest, MXDBOnChangeEvent, QueryProps } from '../common';
import { extendCollection } from './collections/extendCollection';
import { ServerDbCollection } from './providers/db/ServerDbCollection';
import { ServerDispatcher, type ClientDispatcherRequest, type MXDBRecordCursors } from '../common/sync-engine';
import { auditor, AuditEntryType, type AnyAuditOf, type AuditEntry } from '../common/auditor';
import { DELETED_RECORD_REASON, OUTSIDE_READ_GATE_REASON } from './actions/rejectWritesOutsideReadGate';

/**
 * A collection's `onQuery` hook is the app's read gate (e.g. "a fitter sees only their own tasks"). It must
 * narrow EVERY path a client can read a collection through, not just `query` — otherwise a hand-crafted
 * socket request for `get`, `getAll` or `distinct` returns records the gate exists to withhold.
 *
 * Each read path runs against a real MongoDB; what "reaches the client" is what the handler pushes through
 * the S2C synchroniser (the only way records travel to a client) and the ids it returns.
 */

interface Note extends Record {
  ownerId: string;
  colour: string;
}

const gatedNotes = defineCollection<Note>({ name: 'read_gate_notes', indexes: [] });
const openNotes = defineCollection<Note>({ name: 'read_gate_open_notes', indexes: [] });
const overridingNotes = defineCollection<Note>({ name: 'read_gate_overriding_notes', indexes: [] });
const eitherNotes = defineCollection<Note>({ name: 'read_gate_either_notes', indexes: [] });
const COLLECTIONS = [gatedNotes, openNotes, overridingNotes, eitherNotes];

/** The id no record carries, so a filter on it matches nothing. */
const NO_MATCH_ID = 'no-such-record';

// The gate: a caller sees only the notes they own; a caller the server cannot identify sees nothing. Any
// filter the client sent is kept and the gate is AND-ed on top, so a broader filter cannot widen it.
extendCollection(gatedNotes, {
  onQuery({ request, userId }): QueryProps<Note> {
    const gate: DataFilters<Note> = userId == null ? { id: NO_MATCH_ID } : { ownerId: userId };
    const { filters } = request as QueryProps<Note>;
    return { ...request, filters: filters == null ? gate : { $and: [filters, gate] } } as QueryProps<Note>;
  },
});

// An id-overriding gate, like Vision's accounts gate: it REPLACES any `id` filter with the ids the caller may
// see. A `get` must still return only the ids that were asked for.
extendCollection(overridingNotes, {
  onQuery({ request, userId }): QueryProps<Note> {
    const accessibleIds = userId == null ? [] : ALL_NOTES.filter(({ ownerId }) => ownerId === userId).map(({ id }) => id);
    return { ...request, filters: { ...(request as QueryProps<Note>).filters, id: { $in: accessibleIds } } } as QueryProps<Note>;
  },
});

// An `$or` gate: the caller's own notes, and every green one.
extendCollection(eitherNotes, {
  onQuery({ request, userId }): QueryProps<Note> {
    const gate = { $or: [{ ownerId: userId ?? NO_MATCH_ID }, { colour: 'green' }] } as DataFilters<Note>;
    const { filters } = request as QueryProps<Note>;
    return { ...request, filters: filters == null ? gate : { $and: [filters, gate] } } as QueryProps<Note>;
  },
});

// ─── Ambient context (the signed-in user, the db, the S2C synchroniser) ─────────────────────────────────

const ctx = vi.hoisted(() => ({
  userId: undefined as string | undefined,
  /** True outside a request — e.g. inside a change-stream callback, where no auth context exists. */
  hasNoAuthContext: false,
  collections: new Map<string, unknown>(),
  changeListeners: [] as ((event: unknown) => void)[],
  pushedActive: [] as { collectionName: string; ids: string[] }[],
  pushedDeletes: [] as { collectionName: string; ids: string[] }[],
  pushedEvictions: [] as { collectionName: string; ids: string[] }[],
  /** The client connection's S2C dispatcher (a real one; set per test), for the C2S sync path. */
  dispatcher: undefined as unknown,
  dispatched: [] as MXDBRecordCursors[],
  clientData: new Map<string, unknown>(),
}));

vi.mock('@anupheaus/nexus/server', async importOriginal => ({
  ...(await importOriginal<object>()),
  createServerActionHandler: (_action: unknown, handler: unknown) => handler,
  useAuthentication: () => {
    if (ctx.hasNoAuthContext) throw new Error('no auth context outside a request');
    return { user: ctx.userId == null ? undefined : { id: ctx.userId } };
  },
  useLogger: () => {
    const quiet = { warn: () => void 0, error: () => void 0, info: () => void 0, debug: () => void 0, silly: () => void 0, createSubLogger: () => quiet };
    return quiet;
  },
}));

vi.mock('./providers', () => ({
  useDb: () => ({
    use: (name: string) => {
      const collection = ctx.collections.get(name);
      if (collection == null) throw new Error(`Unknown collection "${name}"`);
      return collection;
    },
    onChange: (listener: (event: unknown) => void) => {
      ctx.changeListeners.push(listener);
      return () => { ctx.changeListeners = ctx.changeListeners.filter(existing => existing !== listener); };
    },
  }),
  useServerToClientSynchronisation: () => ({
    isNoOp: false,
    dispatcher: ctx.dispatcher,
    pushActive: async (collectionName: string, records: Record[]) => { ctx.pushedActive.push({ collectionName, ids: records.map(({ id }) => id) }); },
    pushDeletes: async (collectionName: string, ids: string[]) => { ctx.pushedDeletes.push({ collectionName, ids }); },
    pushEvictions: (collectionName: string, ids: string[]) => { ctx.pushedEvictions.push({ collectionName, ids }); },
  }),
}));

vi.mock('./hooks', () => ({
  useClient: () => ({ getData: (key: string) => ctx.clientData.get(key), setData: (key: string, value: unknown) => ctx.clientData.set(key, value) }),
}));

// The subscription factory only adds per-socket bookkeeping; unwrap it so the handler can be called directly.
vi.mock('./subscriptions/createServerCollectionSubscription', () => ({
  createServerCollectionSubscription: () => (_subscription: unknown, handler: unknown) => handler,
}));

// Imported after the mocks so they bind to the mocked context.
const { handleGet } = await import('./actions/getAction');
const { handleGetAll } = await import('./actions/getAllAction');
const { handleDistinct: handleDistinctOfAnyCollection } = await import('./actions/distinctAction');
const { handleQuery } = await import('./actions/queryAction');
const { handleReconcile } = await import('./actions/reconcileAction');
const { serverGetAllSubscription } = await import('./subscriptions/getAllSubscription');
const { serverDistinctSubscription } = await import('./subscriptions/distinctSubscription');
const { serverQuerySubscription } = await import('./subscriptions/querySubscription');
const { handleClientToServerSync } = await import('./actions/clientToServerSyncAction');

// ─── Database ───────────────────────────────────────────────────────────────────────────────────────────

const logger = {
  warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), silly: vi.fn(), createSubLogger: vi.fn().mockReturnThis(),
} as unknown as Logger;

let mongod: MongoMemoryReplSet;
let client: MongoClient;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(mongod.getUri());
  await client.connect();
  const db = client.db('readgatedb');
  const names = COLLECTIONS.flatMap(({ name }) => [name, `${name}_sync`]);
  for (const name of names) await db.createCollection(name);
  for (const collection of COLLECTIONS) {
    ctx.collections.set(collection.name, new ServerDbCollection<Note>({
      getDb: () => Promise.resolve(db),
      collection,
      collectionNames: Promise.resolve(new Set(names)),
      logger,
    }));
  }
}, 90_000);

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

const ALICE = 'alice';
const BOB = 'bob';
const aliceRed: Note = { id: 'alice-red', ownerId: ALICE, colour: 'red' };
const aliceBlue: Note = { id: 'alice-blue', ownerId: ALICE, colour: 'blue' };
const bobGreen: Note = { id: 'bob-green', ownerId: BOB, colour: 'green' };
const ALL_NOTES = [aliceRed, aliceBlue, bobGreen];

function notesIn(name: string): ServerDbCollection<Note> {
  return ctx.collections.get(name) as ServerDbCollection<Note>;
}

beforeEach(async () => {
  for (const { name } of COLLECTIONS) {
    await client.db('readgatedb').collection(name).deleteMany({});
    await client.db('readgatedb').collection(`${name}_sync`).deleteMany({});
    await notesIn(name).upsert(ALL_NOTES);
  }
  ctx.userId = undefined;
  ctx.hasNoAuthContext = false;
  ctx.changeListeners = [];
  ctx.pushedActive = [];
  ctx.pushedDeletes = [];
  ctx.pushedEvictions = [];
  ctx.dispatched = [];
  ctx.dispatcher = new ServerDispatcher(logger, {
    onDispatch: async payload => {
      ctx.dispatched.push(payload as MXDBRecordCursors);
      return payload.map(({ collectionName, records }) => ({ collectionName, successfulRecordIds: records.map(cursor => ('record' in cursor ? cursor.record.id : cursor.recordId)) }));
    },
  });
  ctx.clientData.clear();
});

/** Every record id pushed to the client for `collectionName`. */
function pushedIds(collectionName = gatedNotes.name): string[] {
  return ctx.pushedActive.filter(push => push.collectionName === collectionName).flatMap(({ ids }) => ids).sort();
}

/** Fires a change on the collection the way the change stream does: outside any request's auth context. */
function fireChangeOutsideRequest(collectionName = gatedNotes.name): void {
  ctx.hasNoAuthContext = true;
  const event = { type: 'upsert', collectionName, records: [] } as unknown as MXDBOnChangeEvent;
  // The stream does not await the handlers, so a test waits for the push it expects (WAIT_FOR_PUSH).
  ctx.changeListeners.forEach(listener => listener(event));
}

/** A change handler re-reads the database before it pushes; wait on the outcome, not a fixed delay. */
const WAIT_FOR_PUSH = { timeout: 5_000, interval: 20 };

interface SubscriptionHarness {
  request: unknown;
  subscriptionId: string;
  previousResponse: undefined;
  additionalData: undefined;
  updateAdditionalData: (data: string[]) => void;
  update: ReturnType<typeof vi.fn>;
  onUnsubscribe: (handler: () => void) => void;
}

function subscriptionParams(request: unknown): SubscriptionHarness {
  const subscriptionId = `sub-${Math.random()}`;
  return {
    request, subscriptionId, previousResponse: undefined, additionalData: undefined,
    updateAdditionalData: data => ctx.clientData.set(`subscription-data.additional.${subscriptionId}`, data),
    update: vi.fn(async () => void 0),
    onUnsubscribe: () => void 0,
  };
}

type RawSubscriptionHandler = (params: SubscriptionHarness) => Promise<unknown>;

/** The distinct action, typed for the notes collections. */
function handleDistinct(request: DistinctRequest<Note>): Promise<unknown> {
  return handleDistinctOfAnyCollection(request as unknown as DistinctRequest);
}

// ─── Actions ────────────────────────────────────────────────────────────────────────────────────────────

describe('query (the path that already applied the gate)', () => {
  it('returns only the caller\'s records', async () => {
    ctx.userId = ALICE;
    await handleQuery({ collectionName: gatedNotes.name });
    expect(pushedIds()).toEqual([aliceBlue.id, aliceRed.id]);
  });
});

describe('get', () => {
  it('returns only the requested records the gate lets through', async () => {
    ctx.userId = ALICE;
    const ids = await handleGet({ collectionName: gatedNotes.name, ids: [aliceRed.id, bobGreen.id] });
    expect(ids).toEqual([aliceRed.id]);
    expect(pushedIds()).toEqual([aliceRed.id]);
  });

  it('returns nothing when every requested record is outside the gate', async () => {
    ctx.userId = ALICE;
    expect(await handleGet({ collectionName: gatedNotes.name, ids: [bobGreen.id] })).toEqual([]);
    expect(ctx.pushedActive).toEqual([]);
  });

  it('never widens a get to records that were not asked for', async () => {
    ctx.userId = ALICE;
    expect(await handleGet({ collectionName: gatedNotes.name, ids: [aliceBlue.id] })).toEqual([aliceBlue.id]);
  });

  it('returns nothing to a caller the server cannot identify', async () => {
    expect(await handleGet({ collectionName: gatedNotes.name, ids: [aliceRed.id, bobGreen.id] })).toEqual([]);
    expect(ctx.pushedActive).toEqual([]);
  });

  it('is unchanged for a collection without a gate', async () => {
    ctx.userId = ALICE;
    const ids = await handleGet({ collectionName: openNotes.name, ids: [aliceRed.id, bobGreen.id] });
    expect([...ids].sort()).toEqual([aliceRed.id, bobGreen.id]);
  });
});

describe('getAll', () => {
  it('returns only the caller\'s records', async () => {
    ctx.userId = BOB;
    expect(await handleGetAll({ collectionName: gatedNotes.name })).toEqual([bobGreen.id]);
    expect(pushedIds()).toEqual([bobGreen.id]);
  });

  it('returns nothing to a caller the server cannot identify', async () => {
    expect(await handleGetAll({ collectionName: gatedNotes.name })).toEqual([]);
    expect(ctx.pushedActive).toEqual([]);
  });

  it('is unchanged for a collection without a gate', async () => {
    ctx.userId = BOB;
    expect([...await handleGetAll({ collectionName: openNotes.name })].sort()).toEqual(ALL_NOTES.map(({ id }) => id).sort());
  });
});

describe('distinct', () => {
  it('draws the distinct values from the caller\'s records only', async () => {
    ctx.userId = ALICE;
    await handleDistinct({ collectionName: gatedNotes.name, field: 'colour' });
    // Bob's green note is the only green one: it must not surface as a distinct value.
    expect(pushedIds()).toEqual([aliceBlue.id, aliceRed.id]);
  });

  it('keeps the client\'s own filter AND the gate', async () => {
    ctx.userId = ALICE;
    await handleDistinct({ collectionName: gatedNotes.name, field: 'colour', filters: { colour: { $in: ['red', 'green'] } } });
    expect(pushedIds()).toEqual([aliceRed.id]);
  });

  it('returns nothing to a caller the server cannot identify', async () => {
    await handleDistinct({ collectionName: gatedNotes.name, field: 'colour' });
    expect(ctx.pushedActive).toEqual([]);
  });
});

describe('reconcile', () => {
  it('answers a gated record exactly as a deleted one, and evicts it rather than tombstoning it (sc-608)', async () => {
    ctx.userId = ALICE;
    const response = await handleReconcile([{ collectionName: gatedNotes.name, localIds: [bobGreen.id, 'long-gone', aliceRed.id] }]);
    // The client cannot tell Bob's existing note from one that is gone.
    expect(response).toEqual([{ collectionName: gatedNotes.name, deletedIds: [bobGreen.id, 'long-gone'] }]);
    expect(ctx.pushedActive).toEqual([]);
    // Bob's note still exists: it is evicted, not deleted — a tombstone would refuse it for good (delete-is-final),
    // even once the gate lets it through again.
    expect(ctx.pushedEvictions).toEqual([{ collectionName: gatedNotes.name, ids: [bobGreen.id] }]);
    await vi.waitFor(() => expect(ctx.pushedDeletes).toEqual([{ collectionName: gatedNotes.name, ids: ['long-gone'] }]));
  });
});

// ─── Subscriptions ──────────────────────────────────────────────────────────────────────────────────────

describe('getAll subscription', () => {
  const handler = serverGetAllSubscription as unknown as RawSubscriptionHandler;

  it('sends only the caller\'s records, initially and after a change', async () => {
    ctx.userId = ALICE;
    const initial = await handler(subscriptionParams({ collectionName: gatedNotes.name }));
    expect([...initial as string[]].sort()).toEqual([aliceBlue.id, aliceRed.id]);

    await notesIn(gatedNotes.name).upsert({ id: 'bob-yellow', ownerId: BOB, colour: 'yellow' });
    ctx.pushedActive = [];
    fireChangeOutsideRequest();
    await vi.waitFor(() => expect(pushedIds()).toEqual([aliceBlue.id, aliceRed.id]), WAIT_FOR_PUSH);
  });

  it('does not tombstone a record that has left the gate but still exists', async () => {
    ctx.userId = ALICE;
    await handler(subscriptionParams({ collectionName: gatedNotes.name }));

    // Alice's red note is handed to Bob: it leaves her gate but is not deleted.
    await notesIn(gatedNotes.name).upsert({ ...aliceRed, ownerId: BOB });
    await notesIn(gatedNotes.name).remove(aliceBlue.id);
    fireChangeOutsideRequest();
    await vi.waitFor(() => expect(ctx.pushedDeletes).toEqual([{ collectionName: gatedNotes.name, ids: [aliceBlue.id] }]), WAIT_FOR_PUSH);
  });

  it('sends nothing to a caller the server cannot identify', async () => {
    expect(await handler(subscriptionParams({ collectionName: gatedNotes.name }))).toEqual([]);
    expect(ctx.pushedActive).toEqual([]);
  });

  it('is unchanged for a collection without a gate', async () => {
    ctx.userId = ALICE;
    const initial = await handler(subscriptionParams({ collectionName: openNotes.name }));
    expect([...initial as string[]].sort()).toEqual(ALL_NOTES.map(({ id }) => id).sort());
  });
});

describe('distinct subscription', () => {
  const handler = serverDistinctSubscription as unknown as RawSubscriptionHandler;

  it('draws the distinct values from the caller\'s records only, initially and after a change', async () => {
    ctx.userId = ALICE;
    await handler(subscriptionParams({ collectionName: gatedNotes.name, field: 'colour' }));
    expect(pushedIds()).toEqual([aliceBlue.id, aliceRed.id]);

    await notesIn(gatedNotes.name).upsert({ id: 'bob-yellow', ownerId: BOB, colour: 'yellow' });
    ctx.pushedActive = [];
    fireChangeOutsideRequest();
    await vi.waitFor(() => expect(pushedIds()).toEqual([aliceBlue.id, aliceRed.id]), WAIT_FOR_PUSH);
  });

  it('sends nothing to a caller the server cannot identify', async () => {
    await handler(subscriptionParams({ collectionName: gatedNotes.name, field: 'colour' }));
    expect(ctx.pushedActive).toEqual([]);
  });
});

describe('query subscription (the path that already applied the gate)', () => {
  const handler = serverQuerySubscription as unknown as RawSubscriptionHandler;

  it('sends only the caller\'s records', async () => {
    ctx.userId = BOB;
    await handler(subscriptionParams({ collectionName: gatedNotes.name }));
    expect(pushedIds()).toEqual([bobGreen.id]);
  });
});

// ─── C2S sync (sc-583) ──────────────────────────────────────────────────────────────────────────────────

describe('client-to-server sync', () => {
  /** Sorts before every generated ULID, so the server's version always looks newer than the client's claim. */
  const EARLIEST_ULID = '00000000000000000000000000';

  /** A branch-only probe: the client claims to hold `id` at a hash that is not the server's. */
  function probe(id: string): ClientDispatcherRequest[0]['records'][0] {
    return { id, hash: 'stale-hash', entries: [{ type: AuditEntryType.Branched, id: EARLIEST_ULID } as AuditEntry] };
  }

  /** Every record id whose content was dispatched to the client. */
  function dispatchedRecordIds(): string[] {
    return ctx.dispatched.flatMap(payload => payload.flatMap(({ records }) => records.flatMap(cursor => ('record' in cursor ? [cursor.record.id] : [])))).sort();
  }

  /** Every record id the client was told to evict. */
  function dispatchedEvictionIds(): string[] {
    return ctx.dispatched.flatMap(payload => payload.flatMap(({ records }) => records.flatMap(cursor => (!('record' in cursor) && cursor.isEviction === true ? [cursor.recordId] : [])))).sort();
  }

  /** Audits are written after the record (fire-and-forget); the sync path merges against them, so wait for them. */
  async function auditsWritten(collectionName: string): Promise<void> {
    await vi.waitFor(async () => expect(await client.db('readgatedb').collection(`${collectionName}_sync`).countDocuments()).toBe(ALL_NOTES.length), WAIT_FOR_PUSH);
  }

  function dispatcher(): ServerDispatcher {
    return ctx.dispatcher as ServerDispatcher;
  }

  it('answers a probe for a record outside the gate with nothing, and does not subscribe the client to it', async () => {
    await auditsWritten(gatedNotes.name);
    ctx.userId = ALICE;
    await handleClientToServerSync([{ collectionName: gatedNotes.name, records: [probe(bobGreen.id), probe(aliceRed.id)] }]);
    await vi.waitFor(() => expect(dispatchedRecordIds()).toEqual([aliceRed.id]), WAIT_FOR_PUSH);
    // Answered with an eviction: a device still holding Bob's note (from before it left Alice's gate) drops it.
    expect(dispatchedEvictionIds()).toEqual([bobGreen.id]);

    // Both notes change: only the one Alice may read reaches her through the change stream.
    ctx.dispatched = [];
    dispatcher().push([{ collectionName: gatedNotes.name, records: [{ record: { ...bobGreen, colour: 'teal' }, lastAuditEntryId: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ' }] }], false);
    dispatcher().push([{ collectionName: gatedNotes.name, records: [{ record: { ...aliceRed, colour: 'pink' }, lastAuditEntryId: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ' }] }], false);
    await vi.waitFor(() => expect(dispatchedRecordIds()).toEqual([aliceRed.id]), WAIT_FOR_PUSH);
  });

  it('answers a caller the server cannot identify with nothing from a gated collection', async () => {
    await auditsWritten(gatedNotes.name);
    await auditsWritten(openNotes.name);
    // An ungated record in the same request is the signal the sync's push has gone out.
    await handleClientToServerSync([
      { collectionName: gatedNotes.name, records: [probe(bobGreen.id), probe(aliceRed.id)] },
      { collectionName: openNotes.name, records: [probe(aliceBlue.id)] },
    ]);
    await vi.waitFor(() => expect(dispatchedRecordIds()).toEqual([aliceBlue.id]), WAIT_FOR_PUSH);
  });

  it('is unchanged for a collection without a gate', async () => {
    ctx.userId = ALICE;
    await auditsWritten(openNotes.name);
    await handleClientToServerSync([{ collectionName: openNotes.name, records: [probe(bobGreen.id), probe(aliceRed.id)] }]);
    await vi.waitFor(() => expect(dispatchedRecordIds()).toEqual([aliceRed.id, bobGreen.id].sort()), WAIT_FOR_PUSH);
  });

  it('refuses an id that is not a string before anything is mirrored or queried', async () => {
    ctx.userId = ALICE;
    const malformed = [{ collectionName: gatedNotes.name, records: [{ id: { $gt: '' }, hash: 'stale-hash', entries: [] }] }] as unknown as ClientDispatcherRequest;
    await expect(handleClientToServerSync(malformed)).rejects.toThrow(ArgumentInvalidError);
  });

  describe('writes outside the gate', () => {
    async function auditOf(id: string): Promise<AnyAuditOf<Note>> {
      return (await notesIn(gatedNotes.name).getAudit(id)) as unknown as AnyAuditOf<Note>;
    }

    it('refuses an update to a record the caller may not read, and stores nothing', async () => {
      ctx.userId = ALICE;
      await auditsWritten(gatedNotes.name);
      // Alice tries to hand Bob's note to herself — which would also let her read it.
      const entries = auditor.entriesOf(auditor.updateAuditWithAfterLatest({ ...bobGreen, ownerId: ALICE }, await auditOf(bobGreen.id), bobGreen));
      const response = await handleClientToServerSync([{ collectionName: gatedNotes.name, records: [{ id: bobGreen.id, hash: 'stale-hash', entries }] }]);

      expect(response).toEqual([{ collectionName: gatedNotes.name, successfulRecordIds: [bobGreen.id], rejectedRecords: [{ id: bobGreen.id, reason: OUTSIDE_READ_GATE_REASON }] }]);
      expect(await notesIn(gatedNotes.name).get(bobGreen.id)).toEqual(bobGreen);
      // The device drops its refused edit rather than keep a version the server does not have (sc-612).
      await vi.waitFor(() => expect(dispatchedEvictionIds()).toEqual([bobGreen.id]), WAIT_FOR_PUSH);
      expect(dispatchedRecordIds()).toEqual([]);
    });

    it('acknowledges a repeated delete of an already deleted record quietly (sc-612)', async () => {
      ctx.userId = BOB;
      await auditsWritten(gatedNotes.name);
      await notesIn(gatedNotes.name).remove(bobGreen.id);
      await vi.waitFor(async () => expect((await auditOf(bobGreen.id)).entries.some(({ type }) => type === AuditEntryType.Deleted)).toBe(true), WAIT_FOR_PUSH);
      // Bob's device deleted it too, offline, and now syncs its own delete (or resends one after a lost ack).
      const entries = auditor.entriesOf(auditor.deleteAfterLatest(await auditOf(bobGreen.id)));
      const response = await handleClientToServerSync([{ collectionName: gatedNotes.name, records: [{ id: bobGreen.id, entries }] }]);
      expect(response).toEqual([{ collectionName: gatedNotes.name, successfulRecordIds: [bobGreen.id] }]);
    });

    it('refuses a delete of a record the caller may not read', async () => {
      ctx.userId = ALICE;
      await auditsWritten(gatedNotes.name);
      const entries = auditor.entriesOf(auditor.deleteAfterLatest(await auditOf(bobGreen.id)));
      const response = await handleClientToServerSync([{ collectionName: gatedNotes.name, records: [{ id: bobGreen.id, entries }] }]);

      expect(response[0]!.rejectedRecords).toEqual([{ id: bobGreen.id, reason: OUTSIDE_READ_GATE_REASON }]);
      expect(await notesIn(gatedNotes.name).get(bobGreen.id)).toEqual(bobGreen);
    });

    it('refuses resurrecting a deleted record, whoever it belonged to, and pushes none of it', async () => {
      ctx.userId = ALICE;
      await auditsWritten(gatedNotes.name);
      await auditsWritten(openNotes.name);
      await notesIn(gatedNotes.name).remove(bobGreen.id);
      // The delete's audit entry is written after the record goes (fire-and-forget); the tombstone is what counts.
      await vi.waitFor(async () => expect((await auditOf(bobGreen.id)).entries.some(({ type }) => type === AuditEntryType.Deleted)).toBe(true), WAIT_FOR_PUSH);

      // Restore the tombstone (replay copies the server's last content back to live), then hand the note to Alice.
      const tombstone = await auditOf(bobGreen.id);
      const restored = { type: AuditEntryType.Restored, id: auditor.generateUlid() } as AuditEntry;
      const withRestore = { id: bobGreen.id, entries: [...tombstone.entries, restored] } as AnyAuditOf<Note>;
      const updated = auditor.entriesOf(auditor.updateAuditWithAfterLatest({ ...bobGreen, ownerId: ALICE }, withRestore, bobGreen)).at(-1)!;
      const response = await handleClientToServerSync([
        { collectionName: gatedNotes.name, records: [{ id: bobGreen.id, hash: 'stale-hash', entries: [restored, updated] as AuditEntry[] }] },
        // An ungated record in the same request: the signal that this sync's pushes have gone out.
        { collectionName: openNotes.name, records: [probe(aliceBlue.id)] },
      ]);

      expect(response.find(({ collectionName }) => collectionName === gatedNotes.name)?.rejectedRecords).toEqual([{ id: bobGreen.id, reason: DELETED_RECORD_REASON }]);
      expect(await notesIn(gatedNotes.name).get(bobGreen.id)).toBeUndefined();
      await vi.waitFor(() => expect(dispatchedRecordIds()).toEqual([aliceBlue.id]), WAIT_FOR_PUSH);
    });

    it('still accepts a change to the caller\'s own record, and a new record', async () => {
      ctx.userId = ALICE;
      await auditsWritten(gatedNotes.name);
      const recoloured: Note = { ...aliceRed, colour: 'purple' };
      const created: Note = { id: 'alice-new', ownerId: ALICE, colour: 'white' };
      const response = await handleClientToServerSync([{
        collectionName: gatedNotes.name,
        records: [
          { id: aliceRed.id, hash: 'stale-hash', entries: auditor.entriesOf(auditor.updateAuditWithAfterLatest(recoloured, await auditOf(aliceRed.id), aliceRed)) },
          { id: created.id, hash: 'client-hash', entries: auditor.createAuditFrom(created).entries },
        ],
      }]);

      expect(response[0]!.rejectedRecords).toBeUndefined();
      expect(await notesIn(gatedNotes.name).get(aliceRed.id)).toEqual(recoloured);
      expect(await notesIn(gatedNotes.name).get(created.id)).toEqual(created);
    });
  });
});

// ─── Unusual gate shapes ────────────────────────────────────────────────────────────────────────────────

describe('a gate that replaces the id filter (accounts-style)', () => {
  it('never widens a get to records that were not asked for', async () => {
    ctx.userId = ALICE;
    expect(await handleGet({ collectionName: overridingNotes.name, ids: [aliceRed.id, bobGreen.id] })).toEqual([aliceRed.id]);
    expect(pushedIds(overridingNotes.name)).toEqual([aliceRed.id]);
  });

  it('gives getAll exactly the caller\'s records', async () => {
    ctx.userId = BOB;
    expect(await handleGetAll({ collectionName: overridingNotes.name })).toEqual([bobGreen.id]);
  });
});

describe('an $or gate', () => {
  it('lets through each branch of the gate, and nothing else', async () => {
    ctx.userId = ALICE;
    // Alice's own notes, plus Bob's green one through the colour branch.
    expect([...await handleGetAll({ collectionName: eitherNotes.name })].sort()).toEqual([aliceBlue.id, aliceRed.id, bobGreen.id].sort());
    await notesIn(eitherNotes.name).upsert({ id: 'bob-yellow', ownerId: BOB, colour: 'yellow' });
    expect(await handleGet({ collectionName: eitherNotes.name, ids: ['bob-yellow', bobGreen.id] })).toEqual([bobGreen.id]);
  });

  it('cannot be widened by a client filter with its own $or', async () => {
    ctx.userId = ALICE;
    await notesIn(eitherNotes.name).upsert({ id: 'bob-yellow', ownerId: BOB, colour: 'yellow' });
    await handleDistinct({ collectionName: eitherNotes.name, field: 'colour', filters: { $or: [{ ownerId: BOB }, { ownerId: ALICE }] } as DataFilters<Note> });
    expect(pushedIds(eitherNotes.name)).not.toContain('bob-yellow');
  });
});

// ─── A collection that keeps no audit (sc-612) ─────────────────────────────────────────────────────────────

describe('a collection with disableAudit', () => {
  it('reads no audit — not even a leftover audit collection from before it stopped keeping one', async () => {
    const noAudit = defineCollection<Note>({ name: 'read_gate_no_audit_notes', indexes: [], disableAudit: true });
    const db = client.db('readgatedb');
    await db.collection(`${noAudit.name}_sync`).insertOne({ _id: 'stale' as never, entries: [{ type: AuditEntryType.Deleted, id: 'x' }] });
    const collection = new ServerDbCollection<Note>({
      getDb: () => Promise.resolve(db), collection: noAudit, collectionNames: Promise.resolve(new Set([`${noAudit.name}_sync`])), logger,
    });
    // Were a stale tombstone read here, the write gate and getAuditIds (which reports none) would disagree.
    expect({ audits: await collection.getAudit(['stale']), auditIds: await collection.getAuditIds(['stale']) }).toEqual({ audits: [], auditIds: [] });
  });
});
