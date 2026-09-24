import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InternalError, Logger, Record as MXDBRecord } from '@anupheaus/common';
import type { ClientSession, Db } from 'mongodb';
import { defineCollection } from '../../../common/defineCollection';
import { auditor } from '../../../common/auditor';
import { ServerDbCollection } from './ServerDbCollection';

// ─── Failure-injection tests ──────────────────────────────────────────────────
//
// Complements ServerDbCollection.tests.ts (which runs against a real in-memory replica set) by
// replacing the Mongo `Db` with a fake whose operations can be made to fail on demand. This is the
// only practical way to exercise transient-error retries, session loss and driver-level write
// anomalies deterministically, with fake timers standing in for the retry backoff.

interface Item extends MXDBRecord {
  name: string;
}

const COLLECTION_NAME = 'failure_items';
const AUDIT_COLLECTION_NAME = `${COLLECTION_NAME}_sync`;
const collection = defineCollection<Item>({ name: COLLECTION_NAME, indexes: [] });

const TRANSIENT_ERROR_MESSAGE = 'connection reset by peer';
const MAX_SYNC_ATTEMPTS = 20;

interface WriteOp {
  replaceOne: { filter: { _id: string } };
}

interface MongoCommand {
  collMod?: string;
}

const NAMESPACE_NOT_FOUND = { code: 26, codeName: 'NamespaceNotFound' };
const NAMESPACE_EXISTS = { code: 48, codeName: 'NamespaceExists' };

function mongoError(message: string, { code, codeName }: { code: number; codeName: string }) {
  return Object.assign(new Error(message), { code, codeName });
}

function bulkWriteResult({ isOk = true, writtenCount }: { isOk?: boolean; writtenCount: number }) {
  return { isOk: () => isOk, matchedCount: 0, upsertedCount: writtenCount };
}

function createFakeMongoCollection(name: string) {
  return {
    collectionName: name,
    find: vi.fn((..._args: unknown[]) => ({ toArray: async () => [] as unknown[] })),
    findOne: vi.fn(async (..._args: unknown[]) => null),
    bulkWrite: vi.fn(async (ops: WriteOp[], ..._rest: unknown[]) => bulkWriteResult({ writtenCount: ops.length })),
    deleteOne: vi.fn(async (..._args: unknown[]) => ({ acknowledged: true, deletedCount: 1 })),
    deleteMany: vi.fn(async (..._args: unknown[]) => ({ acknowledged: true, deletedCount: 0 })),
    indexes: async () => [],
    createIndex: async () => name,
    dropIndex: async () => ({}),
  };
}

function createFakeSession() {
  return {
    withTransaction: vi.fn(async (fn: () => Promise<void>) => { await fn(); }),
    endSession: vi.fn(async () => { /* ended */ }),
  };
}

function createFakeDb() {
  const live = createFakeMongoCollection(COLLECTION_NAME);
  const audit = createFakeMongoCollection(AUDIT_COLLECTION_NAME);
  const sessions: ReturnType<typeof createFakeSession>[] = [];
  const pick = (name: string) => (name === AUDIT_COLLECTION_NAME ? audit : live);
  const db = {
    collection: pick,
    createCollection: async (name: string) => pick(name),
    command: async (_command: MongoCommand) => ({ ok: 1 }),
    client: { startSession: () => { const session = createFakeSession(); sessions.push(session); return session; } },
  };
  return { db, live, audit, sessions };
}

function createLogger() {
  const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn(), silly: vi.fn(), createSubLogger: vi.fn() };
  logger.createSubLogger.mockReturnValue(logger);
  return logger;
}

function setup({ registerSession }: { registerSession?: (session: ClientSession) => () => void } = {}) {
  const fake = createFakeDb();
  const logger = createLogger();
  const col = new ServerDbCollection<Item>({
    getDb: async () => fake.db as unknown as Db,
    collection,
    collectionNames: Promise.resolve(new Set([COLLECTION_NAME, AUDIT_COLLECTION_NAME])),
    logger: logger as unknown as Logger,
    registerSession,
  });
  return { ...fake, col, logger };
}

/**
 * A database with no collections yet, as when a tenant is first provisioned. Like real Mongo,
 * `createCollection` completes on a later I/O turn and fails if the collection already exists, and
 * `collMod` fails with NamespaceNotFound on a collection that has not been created.
 */
function setupFreshDb() {
  const fake = createFakeDb();
  const logger = createLogger();
  const createdCollections = new Set<string>();
  const collModCollections: string[] = [];
  let nextCreationError: Error | undefined;
  fake.db.createCollection = async (name: string) => {
    await yieldToRealIo();
    const creationError = nextCreationError;
    nextCreationError = undefined;
    if (creationError != null) throw creationError;
    if (createdCollections.has(name)) throw mongoError(`Collection testdb.${name} already exists.`, NAMESPACE_EXISTS);
    createdCollections.add(name);
    return fake.db.collection(name);
  };
  fake.db.command = async ({ collMod }: MongoCommand) => {
    if (collMod == null || !createdCollections.has(collMod)) throw mongoError(`ns does not exist: testdb.${collMod}`, NAMESPACE_NOT_FOUND);
    collModCollections.push(collMod);
    return { ok: 1 };
  };
  const col = new ServerDbCollection<Item>({
    getDb: async () => fake.db as unknown as Db,
    collection,
    collectionNames: Promise.resolve(new Set<string>()),
    logger: logger as unknown as Logger,
  });
  return {
    col,
    logger,
    createdCollections,
    collModCollections,
    failNextCreation: (error: Error) => { nextCreationError = error; },
    markCreatedElsewhere: (name: string) => { createdCollections.add(name); },
  };
}

function captureUnhandledRejections() {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  return { rejections, stop: () => { process.off('unhandledRejection', onRejection); } };
}

const makeItem = (id: string): Item => ({ id, name: `name-${id}` });
const noAudits = { updatedAudits: [] };

/** Captured before timers are faked: lets real async work (e.g. WebCrypto hashing of records) complete. */
const realSetImmediate = globalThis.setImmediate;
const yieldToRealIo = () => new Promise<void>(resolve => { realSetImmediate(() => resolve()); });
/** Safety valve so a regression that never settles fails fast instead of spinning forever. */
const MAX_SETTLE_ITERATIONS = 10_000;

/**
 * Runs `operation` to completion, moving fake time forward only while the operation is parked on a
 * backoff timer. Record hashing uses real (non-timer) async crypto, so time must not advance while
 * that is in flight — otherwise the measured retry delays would drift.
 */
async function settle<T>(operation: Promise<T>): Promise<T> {
  let isSettled = false;
  operation.then(() => { isSettled = true; }, () => { isSettled = true; });
  for (let iteration = 0; !isSettled && iteration < MAX_SETTLE_ITERATIONS; iteration++) {
    await yieldToRealIo();
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
  }
  return operation;
}

/** Lets background (un-awaited) work run until `condition` holds, advancing fake time only for parked timers. */
async function settleUntil(condition: () => boolean): Promise<void> {
  for (let iteration = 0; iteration < MAX_SETTLE_ITERATIONS; iteration++) {
    if (condition()) return;
    await yieldToRealIo();
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
  }
  throw new Error('settleUntil: condition was never met');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ServerDbCollection under failure', () => {

  // ── sync: upserts ───────────────────────────────────────────────────────────

  describe('sync upserts', () => {
    it('succeeds when a transient write failure clears on retry', async () => {
      const { col, live } = setup();
      live.bulkWrite.mockRejectedValueOnce(new Error(TRANSIENT_ERROR_MESSAGE));
      const results = await settle(col.sync({ updated: [makeItem('r1')], ...noAudits, removedIds: [] }));

      expect(results).toEqual([{ id: 'r1' }]);
    });

    it('backs off exponentially between retries, capped at two seconds', async () => {
      const { col, live } = setup();
      const attemptTimes: number[] = [];
      live.bulkWrite.mockImplementation(async (ops: WriteOp[]) => {
        attemptTimes.push(Date.now());
        if (attemptTimes.length <= 6) throw new Error(TRANSIENT_ERROR_MESSAGE);
        return bulkWriteResult({ writtenCount: ops.length });
      });

      await settle(col.sync({ updated: [makeItem('r1')], ...noAudits, removedIds: [] }));

      const gaps = attemptTimes.slice(1).map((time, index) => time - attemptTimes[index]!);
      expect(gaps).toEqual([100, 200, 400, 800, 1_600, 2_000]);
    });

    it('reports the error for a record that keeps failing', async () => {
      const { col, live } = setup();
      live.bulkWrite.mockRejectedValue(new Error(TRANSIENT_ERROR_MESSAGE));

      const results = await settle(col.sync({ updated: [makeItem('r1')], ...noAudits, removedIds: [] }));

      expect(results).toEqual([{ id: 'r1', error: TRANSIENT_ERROR_MESSAGE }]);
    });

    it(`gives up after ${MAX_SYNC_ATTEMPTS} attempts`, async () => {
      const { col, live } = setup();
      live.bulkWrite.mockRejectedValue(new Error(TRANSIENT_ERROR_MESSAGE));

      await settle(col.sync({ updated: [makeItem('r1')], ...noAudits, removedIds: [] }));

      expect(live.bulkWrite).toHaveBeenCalledTimes(MAX_SYNC_ATTEMPTS);
    });

    const sessionEndedErrors: [string, Error][] = [
      ['a MongoExpiredSessionError', Object.assign(new Error('expired'), { name: 'MongoExpiredSessionError' })],
      ['a "session has ended" error', new Error('MongoBulkWriteError: Cannot use a session that has ended')],
    ];

    it.each(sessionEndedErrors)('does not retry after %s', async (_label, error) => {
      const { col, live } = setup();
      live.bulkWrite.mockRejectedValue(error);

      const results = await settle(col.sync({ updated: [makeItem('r1')], ...noAudits, removedIds: [] }));

      expect({ attempts: live.bulkWrite.mock.calls.length, results }).toEqual({ attempts: 1, results: [{ id: 'r1', error: error.message }] });
    });

    it('still writes the other records in a batch when one record permanently fails', async () => {
      const { col, live } = setup();
      live.bulkWrite.mockImplementation(async (ops: WriteOp[]) => {
        if (ops[0]!.replaceOne.filter._id === 'bad') throw new Error('document failed validation');
        return bulkWriteResult({ writtenCount: ops.length });
      });

      const results = await settle(col.sync({ updated: [makeItem('bad'), makeItem('good')], ...noAudits, removedIds: [] }));

      expect(results).toEqual([{ id: 'bad', error: 'document failed validation' }, { id: 'good' }]);
    });

    it('fails the record when its audit cannot be written', async () => {
      const { col, audit } = setup();
      audit.bulkWrite.mockRejectedValue(new Error('audit collection unavailable'));
      const item = makeItem('r1');

      const results = await settle(col.sync({ updated: [item], updatedAudits: [auditor.createAuditFrom(item)], removedIds: [] }));

      expect(results).toEqual([{ id: 'r1', error: 'audit collection unavailable' }]);
    });

    it('ends the session of every record, including ones that failed', async () => {
      const { col, live, sessions } = setup();
      live.bulkWrite.mockImplementation(async (ops: WriteOp[]) => {
        if (ops[0]!.replaceOne.filter._id === 'bad') throw new Error('document failed validation');
        return bulkWriteResult({ writtenCount: ops.length });
      });

      await settle(col.sync({ updated: [makeItem('bad'), makeItem('good')], ...noAudits, removedIds: [] }));

      expect(sessions.map(session => session.endSession.mock.calls.length)).toEqual([1, 1]);
    });

    it('registers each write session with its owner and unregisters it once the write completes', async () => {
      const unregister = vi.fn();
      const registerSession = vi.fn((_session: ClientSession) => unregister);
      const { col } = setup({ registerSession });

      await settle(col.sync({ updated: [makeItem('r1')], ...noAudits, removedIds: ['r2'] }));

      expect({ registered: registerSession.mock.calls.length, unregistered: unregister.mock.calls.length }).toEqual({ registered: 2, unregistered: 2 });
    });

    it('warns when the driver had to re-run the transaction', async () => {
      const { col, logger, db } = setup();
      const startSession = db.client.startSession;
      db.client.startSession = () => {
        const session = startSession();
        session.withTransaction.mockImplementation(async (fn: () => Promise<void>) => { await fn(); await fn(); });
        return session;
      };

      await settle(col.sync({ updated: [makeItem('r1')], ...noAudits, removedIds: [] }));

      expect(logger.warn).toHaveBeenCalledWith('[sync] slow/retried upsert txn', expect.objectContaining({ recordId: 'r1', attempts: 2 }));
    });
  });

  // ── sync: deletes ───────────────────────────────────────────────────────────

  describe('sync deletes', () => {
    it('succeeds when a transient delete failure clears on retry', async () => {
      const { col, live } = setup();
      live.deleteOne.mockRejectedValueOnce(new Error(TRANSIENT_ERROR_MESSAGE));

      const results = await settle(col.sync({ updated: [], ...noAudits, removedIds: ['r1'] }));

      expect(results).toEqual([{ id: 'r1' }]);
    });

    it('reports the error for a delete that keeps failing', async () => {
      const { col, live } = setup();
      live.deleteOne.mockRejectedValue(new Error(TRANSIENT_ERROR_MESSAGE));

      const results = await settle(col.sync({ updated: [], ...noAudits, removedIds: ['r1'] }));

      expect(results).toEqual([{ id: 'r1', error: TRANSIENT_ERROR_MESSAGE }]);
    });

    it('warns when the driver had to re-run the delete transaction', async () => {
      const { col, logger, db } = setup();
      const startSession = db.client.startSession;
      db.client.startSession = () => {
        const session = startSession();
        session.withTransaction.mockImplementation(async (fn: () => Promise<void>) => { await fn(); await fn(); });
        return session;
      };

      await settle(col.sync({ updated: [], ...noAudits, removedIds: ['r1'] }));

      expect(logger.warn).toHaveBeenCalledWith('[sync] slow/retried delete txn', expect.objectContaining({ recordId: 'r1', attempts: 2 }));
    });
  });

  // ── upsert / remove driver anomalies ────────────────────────────────────────

  describe('upsert', () => {
    it('rejects when the driver reports the bulk write as not ok', async () => {
      const { col, live } = setup();
      live.bulkWrite.mockResolvedValueOnce(bulkWriteResult({ isOk: false, writtenCount: 1 }));

      await expect(col.upsert(makeItem('r1'))).rejects.toThrow('Bulk write failed - result is not as expected');
    });

    it('rejects when fewer records were written than requested', async () => {
      const { col, live } = setup();
      live.bulkWrite.mockResolvedValueOnce(bulkWriteResult({ writtenCount: 1 }));

      await expect(col.upsert([makeItem('r1'), makeItem('r2')])).rejects.toThrow('Upsert failed - expected 2, got 1');
    });

    it('still resolves, logging the failure, when the follow-up audit write fails', async () => {
      const { col, audit, logger } = setup();
      audit.bulkWrite.mockRejectedValue(new Error('audit collection unavailable'));

      await col.upsert(makeItem('r1'));

      await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith('Audit upsert failed', { error: 'audit collection unavailable' }));
    });
  });

  describe('remove', () => {
    it('rejects when the driver does not acknowledge the delete', async () => {
      const { col, live } = setup();
      live.deleteMany.mockResolvedValueOnce({ acknowledged: false, deletedCount: 0 });

      await expect(col.remove('r1')).rejects.toThrow('Delete failed');
    });
  });

  // ── brand-new database ──────────────────────────────────────────────────────

  describe('on a brand-new database', () => {
    it('shares one creation per collection between the first writes and the background configuration, with no unhandled rejection', async () => {
      const captured = captureUnhandledRejections();
      try {
        const { col, logger, createdCollections, collModCollections } = setupFreshDb();

        await settle(Promise.all([col.upsert(makeItem('r1')), col.upsert(makeItem('r2'))]));
        await settleUntil(() => collModCollections.length === 2);

        expect({
          created: [...createdCollections].sort(),
          collMod: [...collModCollections].sort(),
          errors: logger.error.mock.calls,
          rejections: captured.rejections,
        }).toEqual({
          created: [COLLECTION_NAME, AUDIT_COLLECTION_NAME],
          collMod: [COLLECTION_NAME, AUDIT_COLLECTION_NAME],
          errors: [],
          rejections: [],
        });
      } finally {
        captured.stop();
      }
    });

    it('lets a later caller retry creating a collection after the first creation failed', async () => {
      const { col, logger, failNextCreation } = setupFreshDb();
      failNextCreation(new Error('network blip during createCollection'));
      await settleUntil(() => logger.error.mock.calls.length > 0);

      await expect(settle(col.getAll())).resolves.toEqual([]);
    });

    it('uses a collection created elsewhere since start-up instead of failing', async () => {
      const { col, logger, markCreatedElsewhere, collModCollections } = setupFreshDb();
      markCreatedElsewhere(COLLECTION_NAME);

      await settle(col.getAll());
      await settleUntil(() => collModCollections.length === 2);

      expect(logger.error.mock.calls).toEqual([]);
    });
  });

  // ── background configuration ────────────────────────────────────────────────

  describe('background configuration', () => {
    it('logs a failed configuration with the original Mongo error attached instead of leaving an unhandled rejection', async () => {
      const captured = captureUnhandledRejections();
      try {
        const unauthorized = mongoError('not authorized on testdb to execute command { collMod: "failure_items" }', { code: 13, codeName: 'Unauthorized' });
        const { db, logger } = setup();
        db.command = async () => { throw unauthorized; };

        await settleUntil(() => logger.error.mock.calls.length > 0);

        const [[message, meta]] = logger.error.mock.calls as unknown as [[string, { collectionName: string; error: InternalError }]];
        expect({
          message,
          collectionName: meta.collectionName,
          errorMessage: meta.error.message,
          cause: meta.error.meta?.cause,
          rejections: captured.rejections,
        }).toEqual({
          message: 'Failed to configure collection',
          collectionName: COLLECTION_NAME,
          errorMessage: `Unable to update change stream settings for "${COLLECTION_NAME}" — ensure the user has Atlas Admin privileges.`,
          cause: { name: 'Error', message: unauthorized.message, code: 13, codeName: 'Unauthorized' },
          rejections: [],
        });
      } finally {
        captured.stop();
      }
    });
  });
});
