import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { DataFilters, Logger, Record } from '@anupheaus/common';
import { defineCollection } from '../common/defineCollection';
import type { DistinctRequest, MXDBOnChangeEvent, QueryProps } from '../common';
import { extendCollection } from './collections/extendCollection';
import { ServerDbCollection } from './providers/db/ServerDbCollection';

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

const gatedNotes = defineCollection<Note>({ name: 'read_gate_notes', indexes: [], disableAudit: true });
const openNotes = defineCollection<Note>({ name: 'read_gate_open_notes', indexes: [], disableAudit: true });
const COLLECTIONS = [gatedNotes, openNotes];

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

// ─── Ambient context (the signed-in user, the db, the S2C synchroniser) ─────────────────────────────────

const ctx = vi.hoisted(() => ({
  userId: undefined as string | undefined,
  /** True outside a request — e.g. inside a change-stream callback, where no auth context exists. */
  hasNoAuthContext: false,
  collections: new Map<string, unknown>(),
  changeListeners: [] as ((event: unknown) => void)[],
  pushedActive: [] as { collectionName: string; ids: string[] }[],
  pushedDeletes: [] as { collectionName: string; ids: string[] }[],
  clientData: new Map<string, unknown>(),
}));

vi.mock('@anupheaus/nexus/server', async importOriginal => ({
  ...(await importOriginal<object>()),
  createServerActionHandler: (_action: unknown, handler: unknown) => handler,
  useAuthentication: () => {
    if (ctx.hasNoAuthContext) throw new Error('no auth context outside a request');
    return { user: ctx.userId == null ? undefined : { id: ctx.userId } };
  },
  useLogger: () => ({ warn: () => void 0, error: () => void 0, info: () => void 0, debug: () => void 0, silly: () => void 0 }),
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
    pushActive: async (collectionName: string, records: Record[]) => { ctx.pushedActive.push({ collectionName, ids: records.map(({ id }) => id) }); },
    pushDeletes: async (collectionName: string, ids: string[]) => { ctx.pushedDeletes.push({ collectionName, ids }); },
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
    await notesIn(name).upsert(ALL_NOTES);
  }
  ctx.userId = undefined;
  ctx.hasNoAuthContext = false;
  ctx.changeListeners = [];
  ctx.pushedActive = [];
  ctx.pushedDeletes = [];
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
  it('confirms a deletion but never pushes a record, so a gated record cannot be read through it', async () => {
    ctx.userId = ALICE;
    const response = await handleReconcile([{ collectionName: gatedNotes.name, localIds: [bobGreen.id, 'long-gone'] }]);
    expect(response).toEqual([{ collectionName: gatedNotes.name, deletedIds: ['long-gone'] }]);
    expect(ctx.pushedActive).toEqual([]);
    // Bob's note still exists: telling the client it was deleted would tombstone it on the device, and a
    // tombstone refuses the record for good (delete-is-final) — even after the gate later lets it through.
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
