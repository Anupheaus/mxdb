/* eslint-disable max-classes-per-file -- fakes for the browser/driver classes this module talks to */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { AsyncLocalStorage } from 'async_hooks';
import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import type { ClientSession } from 'mongodb';
import { defineCollection } from '../../../common/defineCollection';
import type { MXDBCollection } from '../../../common';
import { extendCollection } from '../../collections/extendCollection';
import { ServerDb } from './ServerDb';
import type { ServerDbChangeEvent } from './server-db-models';

// ─── Fake MongoDB driver (external boundary) ──────────────────────────────────
//
// ServerDb owns its MongoClient, so the driver is replaced wholesale with an in-memory fake.
// Tests drive it by queueing connect outcomes and emitting change-stream / client events,
// which keeps every scenario (retries, reconnects, change fan-out) deterministic under fake timers.

class FakeChangeStream extends EventEmitter {
  close = vi.fn(async () => { /* closed */ });
}

function createFakeCollection(name: string) {
  return {
    collectionName: name,
    indexes: async () => [],
    createIndex: async () => name,
    dropIndex: async () => ({}),
    drop: vi.fn(async () => true),
  };
}

class FakeMongoDb {
  changeStream = new FakeChangeStream();
  watch = vi.fn((..._args: unknown[]) => this.changeStream);
  #collections = new Map<string, ReturnType<typeof createFakeCollection>>();
  listCollections = () => ({ toArray: async () => [...this.#collections.keys()].map(name => ({ name })) });
  collection = (name: string) => this.#collections.getOrSet(name, () => createFakeCollection(name));
  createCollection = async (name: string) => this.collection(name);
  collections = async () => [...this.#collections.values()];
  command = async () => ({ ok: 1 });
}

/** Outcome for each successive `connect()` call: `'ok'` resolves, anything else is thrown. */
type ConnectOutcome = 'ok' | unknown;

const fakeMongo = {
  db: new FakeMongoDb(),
  connectOutcomes: [] as ConnectOutcome[],
  clients: [] as FakeMongoClient[],
};

class FakeMongoClient extends EventEmitter {
  constructor(public url: string) { super(); fakeMongo.clients.push(this); }
  connectTimes: number[] = [];
  dbNames: string[] = [];
  connect = vi.fn(async () => {
    this.connectTimes.push(Date.now());
    const outcome = fakeMongo.connectOutcomes.shift() ?? 'ok';
    if (outcome !== 'ok') throw outcome;
    return this;
  });
  db = (name: string) => { this.dbNames.push(name); return fakeMongo.db; };
  close = vi.fn(async (_force?: boolean) => { /* closed */ });
}

vi.mock('mongodb', () => ({ MongoClient: class { constructor(url: string) { return new FakeMongoClient(url); } } }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface Item extends MXDBRecord {
  name: string;
}

const DEBOUNCE_MS = 10;
const DB_NAME = 'server-db-tests';
const MONGO_URL = 'mongodb://fake-host:27017';

function createLogger() {
  const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn(), silly: vi.fn(), createSubLogger: vi.fn() };
  logger.createSubLogger.mockReturnValue(logger);
  return logger;
}

let collectionCounter = 0;
/** Unique collection per test so the module-level extension registry never leaks between tests. */
function makeCollection(): MXDBCollection<Item> {
  collectionCounter += 1;
  return defineCollection<Item>({ name: `server_db_items_${collectionCounter}`, indexes: [] });
}

interface MakeServerDbProps {
  collections?: MXDBCollection[];
  watch?: boolean;
}

function makeServerDb({ collections = [], watch }: MakeServerDbProps = {}) {
  const logger = createLogger();
  const serverDb = new ServerDb({
    mongoDbName: DB_NAME,
    mongoDbUrl: MONGO_URL,
    collections,
    logger: logger as unknown as Logger,
    changeStreamDebounceMs: DEBOUNCE_MS,
    watch,
  });
  const client = fakeMongo.clients.at(-1)!;
  return { serverDb, logger, client };
}

/** Builds a change-stream document the way the Mongo driver delivers it. */
function changeEvent(operationType: string, collectionName: string, doc: { _id: string; name?: string }, extra: object = {}) {
  return { operationType, ns: { db: DB_NAME, coll: collectionName }, documentKey: { _id: doc._id }, fullDocument: doc, ...extra };
}

async function makeWatchingServerDb(collection: MXDBCollection<Item>) {
  const ctx = makeServerDb({ collections: [collection] });
  await ctx.serverDb.getMongoDb();
  const events: ServerDbChangeEvent[] = [];
  ctx.serverDb.onChange(event => { events.push(event); });
  const emit = (change: object) => fakeMongo.db.changeStream.emit('change', change);
  return { ...ctx, events, emit };
}

function makeSession({ inTransaction = true } = {}) {
  return {
    inTransaction: vi.fn(() => inTransaction),
    abortTransaction: vi.fn(async () => { /* aborted */ }),
    endSession: vi.fn(async () => { /* ended */ }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  fakeMongo.db = new FakeMongoDb();
  fakeMongo.connectOutcomes = [];
  fakeMongo.clients = [];
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ServerDb', () => {

  // ── connection ─────────────────────────────────────────────────────────────

  describe('connection', () => {
    it('creates its MongoClient for the configured url', () => {
      const { client } = makeServerDb();
      expect(client.url).toBe(MONGO_URL);
    });

    it('resolves getMongoDb to the named database once connected', async () => {
      const { serverDb, client } = makeServerDb();
      const db = await serverDb.getMongoDb();
      expect({ isFakeDb: db === (fakeMongo.db as unknown), dbNames: client.dbNames }).toEqual({ isFakeDb: true, dbNames: [DB_NAME] });
    });

    it.each([
      ['an Error', new Error('connection refused')],
      ['a non-Error value', 'socket hang up'],
    ])('keeps retrying after a connect failure with %s', async (_label, failure) => {
      fakeMongo.connectOutcomes = [failure];
      const { serverDb, client } = makeServerDb();

      await vi.runAllTimersAsync();
      await serverDb.getMongoDb();

      expect(client.connect).toHaveBeenCalledTimes(2);
    });

    it('logs each failed connect attempt with the attempt number and retry delay', async () => {
      fakeMongo.connectOutcomes = [new Error('connection refused')];
      const { logger } = makeServerDb();

      await vi.runAllTimersAsync();

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('attempt 1'), { error: 'connection refused', attempt: 1, delayMs: 500 });
    });

    it('backs off between retries following a Fibonacci sequence capped at 60 seconds', async () => {
      const failureCount = 13;
      fakeMongo.connectOutcomes = Array.ofSize(failureCount).map(() => new Error('down'));
      const { client } = makeServerDb();

      await vi.runAllTimersAsync();

      const gaps = client.connectTimes.slice(1).map((time, index) => time - client.connectTimes[index]!);
      expect(gaps).toEqual([500, 1_000, 1_500, 2_500, 4_000, 6_500, 10_500, 17_000, 27_500, 44_500, 60_000, 60_000, 60_000]);
    });

    it('does not resolve getMongoDb until a retry succeeds', async () => {
      fakeMongo.connectOutcomes = [new Error('down')];
      const { serverDb } = makeServerDb();
      let isResolved = false;
      void serverDb.getMongoDb().then(() => { isResolved = true; });

      await vi.advanceTimersByTimeAsync(499);

      expect(isResolved).toBe(false);
    });

    it('reconnects when the connection closes unexpectedly', async () => {
      const { serverDb, client } = makeServerDb();
      await serverDb.getMongoDb();

      client.emit('connectionClosed', {});
      await serverDb.getMongoDb();

      expect(client.connect).toHaveBeenCalledTimes(2);
    });

    it('restarts the backoff from its initial delay after a successful connect', async () => {
      fakeMongo.connectOutcomes = [new Error('down'), new Error('down')];
      const { serverDb, client } = makeServerDb();
      await vi.runAllTimersAsync();
      await serverDb.getMongoDb();

      fakeMongo.connectOutcomes = [new Error('down again')];
      client.emit('connectionClosed', {});
      await vi.runAllTimersAsync();

      const lastGap = client.connectTimes.at(-1)! - client.connectTimes.at(-2)!;
      expect(lastGap).toBe(500);
    });

    it('does not reconnect when the connection closes during shutdown', async () => {
      const { serverDb, client } = makeServerDb();
      await serverDb.getMongoDb();
      await serverDb.close();

      client.emit('connectionClosed', {});

      expect(client.connect).toHaveBeenCalledTimes(1);
    });

    it('closes the change stream when the client closes', async () => {
      const { serverDb, client } = makeServerDb();
      await serverDb.getMongoDb();

      client.emit('close');

      expect(fakeMongo.db.changeStream.close).toHaveBeenCalledTimes(1);
    });

    it('logs driver errors instead of throwing', async () => {
      const { client, logger } = makeServerDb();
      const error = new Error('driver blew up');

      client.emit('error', error);

      expect(logger.error).toHaveBeenCalledWith('Database direct error', { error });
    });

    it.each(['commandStarted', 'commandFailed', 'commandSucceeded'])('logs %s driver events at debug level', eventName => {
      const { client, logger } = makeServerDb();
      const event = { commandName: 'find' };

      client.emit(eventName, event);

      expect(logger.debug).toHaveBeenCalledWith(expect.any(String), { event });
    });
  });

  // ── change stream watcher ──────────────────────────────────────────────────

  describe('change stream watcher', () => {
    it('watches the database with pre-images requested', async () => {
      const { serverDb } = makeServerDb();
      await serverDb.getMongoDb();
      expect(fakeMongo.db.watch).toHaveBeenCalledWith(expect.any(Array), { fullDocumentBeforeChange: 'whenAvailable' });
    });

    it('does not watch the database when watch is false', async () => {
      const { serverDb } = makeServerDb({ watch: false });
      await serverDb.getMongoDb();
      expect(fakeMongo.db.watch).not.toHaveBeenCalled();
    });

    it('logs change stream errors instead of throwing', async () => {
      const { serverDb, logger } = makeServerDb();
      await serverDb.getMongoDb();

      fakeMongo.db.changeStream.emit('error', new Error('cursor killed'));

      expect(logger.error).toHaveBeenCalledWith('[ServerDb] changeStream error', { error: 'cursor killed' });
    });

    it('logs when the change stream closes', async () => {
      const { serverDb, logger } = makeServerDb();
      await serverDb.getMongoDb();

      fakeMongo.db.changeStream.emit('close');

      expect(logger.info).toHaveBeenCalledWith('[ServerDb] changeStream closed');
    });
  });

  // ── change fan-out ─────────────────────────────────────────────────────────

  describe('onChange', () => {
    it.each([
      ['insert', 'insert'],
      ['create', 'insert'],
      ['update', 'update'],
      ['replace', 'update'],
    ])('reports a "%s" change as an %s of the deserialised record', async (operationType, expectedType) => {
      const collection = makeCollection();
      const { events, emit } = await makeWatchingServerDb(collection);

      emit(changeEvent(operationType, collection.name, { _id: 'rec-1', name: 'Alpha' }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(events).toEqual([{ collectionName: collection.name, type: expectedType, records: [{ id: 'rec-1', name: 'Alpha' }] }]);
    });

    it('reports a delete change with the deleted record id', async () => {
      const collection = makeCollection();
      const { events, emit } = await makeWatchingServerDb(collection);

      emit({ operationType: 'delete', ns: { db: DB_NAME, coll: collection.name }, documentKey: { _id: 'rec-9' } });
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(events).toEqual([{ collectionName: collection.name, type: 'delete', recordIds: ['rec-9'] }]);
    });

    it('batches changes that arrive within the debounce window into one notification', async () => {
      const collection = makeCollection();
      const { events, emit } = await makeWatchingServerDb(collection);

      emit(changeEvent('insert', collection.name, { _id: 'a', name: 'A' }));
      emit(changeEvent('insert', collection.name, { _id: 'b', name: 'B' }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(events).toEqual([{ collectionName: collection.name, type: 'insert', records: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }]);
    });

    it('does not notify before the debounce window has elapsed', async () => {
      const collection = makeCollection();
      const { events, emit } = await makeWatchingServerDb(collection);

      emit(changeEvent('insert', collection.name, { _id: 'a', name: 'A' }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);

      expect(events).toEqual([]);
    });

    const ignoredChanges: [string, (collectionName: string) => object][] = [
      ['changes to collections not in the config', () => changeEvent('insert', 'someone_elses_collection', { _id: 'x', name: 'X' })],
      ['changes without a namespace', () => ({ operationType: 'insert', fullDocument: { _id: 'x', name: 'X' } })],
      ['changes with an unmapped operation type', collectionName => ({ operationType: 'drop', ns: { db: DB_NAME, coll: collectionName } })],
      ['updates whose document did not actually change', collectionName => changeEvent('update', collectionName, { _id: 'x', name: 'X' }, { fullDocumentBeforeChange: { _id: 'x', name: 'X' } })],
    ];

    it.each(ignoredChanges)('ignores %s', async (_label, buildChange) => {
      const collection = makeCollection();
      const { events, emit } = await makeWatchingServerDb(collection);

      emit(buildChange(collection.name));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(events).toEqual([]);
    });

    it('stops notifying a callback once it has unsubscribed', async () => {
      const collection = makeCollection();
      const { serverDb, emit } = await makeWatchingServerDb(collection);
      const callback = vi.fn();
      const unsubscribe = serverDb.onChange(callback);

      unsubscribe();
      emit(changeEvent('insert', collection.name, { _id: 'a', name: 'A' }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(callback).not.toHaveBeenCalled();
    });

    it('invokes callbacks inside the async context they were registered from', async () => {
      const collection = makeCollection();
      const { serverDb, emit } = await makeWatchingServerDb(collection);
      const storage = new AsyncLocalStorage<string>();
      const seenStores: (string | undefined)[] = [];
      storage.run('subscriber-context', () => serverDb.onChange(() => { seenStores.push(storage.getStore()); }));

      emit(changeEvent('insert', collection.name, { _id: 'a', name: 'A' }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(seenStores).toEqual(['subscriber-context']);
    });
  });

  // ── onAfter* extension hooks ───────────────────────────────────────────────

  describe('extension hooks', () => {
    it.each([
      ['insert', { insertedIds: ['a'], updatedIds: [] }],
      ['update', { insertedIds: [], updatedIds: ['a'] }],
    ])('runs onAfterUpsert for an %s with the changed records', async (operationType, expectedIds) => {
      const collection = makeCollection();
      const onAfterUpsert = vi.fn();
      extendCollection(collection, { onAfterUpsert });
      const { emit } = await makeWatchingServerDb(collection);

      emit(changeEvent(operationType, collection.name, { _id: 'a', name: 'A' }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(onAfterUpsert).toHaveBeenCalledWith({ records: [{ id: 'a', name: 'A' }], ...expectedIds });
    });

    it('runs onAfterDelete with the deleted record ids', async () => {
      const collection = makeCollection();
      const onAfterDelete = vi.fn();
      extendCollection(collection, { onAfterDelete });
      const { emit } = await makeWatchingServerDb(collection);

      emit({ operationType: 'delete', ns: { db: DB_NAME, coll: collection.name }, documentKey: { _id: 'gone' } });
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(onAfterDelete).toHaveBeenCalledWith({ recordIds: ['gone'] });
    });

    it('notifies change callbacks only after the onAfter hook has finished', async () => {
      const collection = makeCollection();
      let finishHook: () => void = () => { /* replaced below */ };
      extendCollection(collection, { onAfterUpsert: () => new Promise<void>(resolve => { finishHook = resolve; }) });
      const { events, emit } = await makeWatchingServerDb(collection);
      emit(changeEvent('insert', collection.name, { _id: 'a', name: 'A' }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      const notifiedBeforeHookFinished = events.length;

      finishHook();
      await vi.advanceTimersByTimeAsync(0);

      expect({ notifiedBeforeHookFinished, notifiedAfter: events.length }).toEqual({ notifiedBeforeHookFinished: 0, notifiedAfter: 1 });
    });

    it('still notifies change callbacks when an onAfter hook throws', async () => {
      const collection = makeCollection();
      extendCollection(collection, { onAfterUpsert: async () => { throw new Error('hook failed'); } });
      const { events, emit } = await makeWatchingServerDb(collection);

      emit(changeEvent('insert', collection.name, { _id: 'a', name: 'A' }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(events).toHaveLength(1);
    });

    it('logs the failure when an onAfter hook throws', async () => {
      const collection = makeCollection();
      const error = new Error('hook failed');
      extendCollection(collection, { onAfterUpsert: async () => { throw error; } });
      const { emit, logger } = await makeWatchingServerDb(collection);

      emit(changeEvent('insert', collection.name, { _id: 'a', name: 'A' }));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(logger.error).toHaveBeenCalledWith('Extension onAfter hook failed', { collectionName: collection.name, type: 'insert', error });
    });
  });

  // ── use / clear ────────────────────────────────────────────────────────────

  describe('use', () => {
    it('returns the db collection for a configured collection name', () => {
      const collection = makeCollection();
      const { serverDb } = makeServerDb({ collections: [collection] });
      expect(serverDb.use(collection.name).collection).toBe(collection);
    });

    it('returns undefined for a collection that is not configured', () => {
      const { serverDb } = makeServerDb();
      expect(serverDb.use('not_configured')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('drops every collection in the database', async () => {
      const { serverDb } = makeServerDb();
      const collections = [fakeMongo.db.collection('one'), fakeMongo.db.collection('two')];

      await serverDb.clear();

      expect(collections.map(collection => collection.drop.mock.calls.length)).toEqual([1, 1]);
    });
  });

  // ── close ──────────────────────────────────────────────────────────────────

  describe('close', () => {
    it('reports isClosing only once close has been called', async () => {
      const { serverDb } = makeServerDb();
      const before = serverDb.isClosing;

      await serverDb.close();

      expect({ before, after: serverDb.isClosing }).toEqual({ before: false, after: true });
    });

    it('aborts the transaction of every registered session that is mid-transaction', async () => {
      const { serverDb } = makeServerDb();
      const session = makeSession({ inTransaction: true });
      serverDb.registerSession(session as unknown as ClientSession);

      await serverDb.close();

      expect(session.abortTransaction).toHaveBeenCalledTimes(1);
    });

    it('does not abort sessions that are not in a transaction', async () => {
      const { serverDb } = makeServerDb();
      const session = makeSession({ inTransaction: false });
      serverDb.registerSession(session as unknown as ClientSession);

      await serverDb.close();

      expect(session.abortTransaction).not.toHaveBeenCalled();
    });

    it('ends every registered session', async () => {
      const { serverDb } = makeServerDb();
      const sessions = [makeSession({ inTransaction: true }), makeSession({ inTransaction: false })];
      sessions.forEach(session => serverDb.registerSession(session as unknown as ClientSession));

      await serverDb.close();

      expect(sessions.map(session => session.endSession.mock.calls.length)).toEqual([1, 1]);
    });

    it('leaves sessions that were unregistered before close untouched', async () => {
      const { serverDb } = makeServerDb();
      const session = makeSession();
      const unregister = serverDb.registerSession(session as unknown as ClientSession);
      unregister();

      await serverDb.close();

      expect(session.endSession).not.toHaveBeenCalled();
    });

    it('completes even when sessions fail to abort or end', async () => {
      const { serverDb, client } = makeServerDb();
      const throwingSession = { inTransaction: () => { throw new Error('ended'); }, endSession: () => { throw new Error('ended'); } };
      const rejectingSession = { inTransaction: () => true, abortTransaction: async () => { throw new Error('ended'); }, endSession: async () => { throw new Error('ended'); } };
      serverDb.registerSession(throwingSession as unknown as ClientSession);
      serverDb.registerSession(rejectingSession as unknown as ClientSession);

      await serverDb.close();

      expect(client.close).toHaveBeenCalledWith(true);
    });

    it('closes the change stream', async () => {
      const { serverDb } = makeServerDb();
      await serverDb.getMongoDb();

      await serverDb.close();

      expect(fakeMongo.db.changeStream.close).toHaveBeenCalledTimes(1);
    });

    it('force-closes the Mongo client', async () => {
      const { serverDb, client } = makeServerDb();
      await serverDb.close();
      expect(client.close).toHaveBeenCalledWith(true);
    });

    it('only shuts down once when called repeatedly', async () => {
      const { serverDb, client } = makeServerDb();

      await serverDb.close();
      await serverDb.close();

      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it('resolves and logs a warning when the Mongo client fails to close', async () => {
      const { serverDb, client, logger } = makeServerDb();
      client.close.mockRejectedValueOnce(new Error('pool busy'));

      await serverDb.close();

      expect(logger.warn).toHaveBeenCalledWith('[ServerDb] close — MongoClient.close threw', { error: 'pool busy' });
    });
  });
});
