import type { DataFilters, DataResponse, Logger } from '@anupheaus/common';
import { bind, DataSorts, Error as CommonError, InternalError, is, type Record } from '@anupheaus/common';
import type { MXDBCollectionConfig, MXDBCollectionIndex } from '../../../common';
import { configRegistry, type MongoDocOf, type MXDBCollection, type QueryProps, type DistinctProps } from '../../../common';
import type { ClientSession, Collection, Db, Document, IndexDescriptionInfo, Sort, WithId } from 'mongodb';
import { dbUtils } from './db-transforms';
import { useAuthentication } from '@anupheaus/nexus/server';
import { DateTime } from 'luxon';
import { auditor } from '../../../common';
import type { AnyAuditOf, ServerAuditOf } from '../../../common';
import { toServerAuditOf } from '../../audit/toServerAuditOf';
import { runBeforeUpsertHook } from '../../collections/runBeforeUpsertHook';
import { runBeforeDeleteHook } from '../../collections/runBeforeDeleteHook';
import { getCollectionExtensions } from '../../collections/extendCollection';

const slowFilterParseThreshold = 1000;
const slowQueryThreshold = 3000;

const SORT_ASCENDING = 1;
const SORT_DESCENDING = -1;

/** MongoDB sort document; key order is significant (earlier keys sort first). */
interface MongoSortSpec {
  [field: string]: typeof SORT_ASCENDING | typeof SORT_DESCENDING;
}

/**
 * Makes a query's result order deterministic so offset/limit pages never overlap or skip records:
 * with no requested sort, natural (insertion) order is used; otherwise `_id` is appended as a final
 * tie-breaker (unless the caller already sorts on it) so records with equal sort keys keep a fixed order.
 */
function withStableOrder(sort: MongoSortSpec | undefined): Sort {
  if (sort == null) return { $natural: SORT_ASCENDING };
  if ('_id' in sort) return sort;
  return { ...sort, _id: SORT_ASCENDING };
}

/**
 * Recursively translates a filter value into its MongoDB form: `id` keys become `_id` and Luxon
 * `DateTime`s become native `Date`s. Recurses into arrays too, so values inside logical operators
 * (`$or`/`$and`/`$nor`) and array operators (`$in`/`$nin`/`$all`) are translated as well — otherwise
 * `{ $or: [{ id: 'a' }] }` would query a non-existent `id` field and silently match nothing.
 * Returns new objects/arrays; the caller's filters are never mutated.
 */
function toMongoFilterValue(value: unknown): unknown {
  if (DateTime.isDateTime(value)) return value.toJSDate();
  if (Array.isArray(value)) return value.map(toMongoFilterValue);
  if (!is.plainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [
    key === 'id' ? '_id' : key,
    toMongoFilterValue(nestedValue),
  ]));
}

/** MongoDB error code returned by `createCollection` when the namespace already exists. */
const NAMESPACE_EXISTS_ERROR_CODE = 48;

interface MongoErrorDetails {
  name?: string;
  message: string;
  code?: unknown;
  codeName?: unknown;
}

/**
 * Extracts the useful fields of a (usually MongoDB driver) error. Native errors serialise to `{}` in
 * log meta because their fields are not enumerable, which would hide the real cause.
 */
function describeMongoError(error: unknown): MongoErrorDetails {
  if (!(error instanceof globalThis.Error)) return { message: String(error) };
  const { code, codeName } = error as { code?: unknown; codeName?: unknown };
  return { name: error.name, message: error.message, code, codeName };
}

/** Common errors are serialised (with their meta) by the logger; anything else is reduced to its details. */
function toLoggableError(error: unknown): CommonError | MongoErrorDetails {
  return error instanceof CommonError ? error : describeMongoError(error);
}

// Transient failure retry config (per-record)
const SYNC_RETRY_BASE_DELAY_MS = 100;
const SYNC_RETRY_MAX_DELAY_MS = 2_000;
const SYNC_MAX_RETRIES = 20;

export interface SyncWriteResult {
  id: string;
  /** Set when write permanently failed after all retries. */
  error?: string;
}

export interface DbCollectionSyncProps<RecordType extends Record> {
  updated: RecordType[];
  updatedAudits: AnyAuditOf<RecordType>[];
  removedIds: string[];
}

export interface UpsertProps {
  resetAudit?: boolean;
}

export interface DeleteProps<RT extends Record = Record> {
  clearAudit?: boolean;
  /** When removing without clearing audit, supply live rows to persist on delete entries (see {@link ServerDbCollection.remove}). */
  deleteSnapshots?: { [recordId: string]: RT };
}

interface Props<RecordType extends Record> {
  getDb(): Promise<Db>;
  collection: MXDBCollection<RecordType>;
  collectionNames: Promise<Set<string>>;
  logger: Logger;
  /** Hook to register an active ClientSession with the owning ServerDb so it can be aborted on shutdown. */
  registerSession?(session: ClientSession): () => void;
}

export class ServerDbCollection<RecordType extends Record = Record> {
  constructor({ getDb, collection, collectionNames, logger, registerSession }: Props<RecordType>) {
    this.#getDb = getDb;
    this.#collection = collection;
    this.#collectionNames = collectionNames;
    this.#config = configRegistry.getOrError(collection);
    this.#logger = logger.createSubLogger(collection.name);
    this.#registerSession = registerSession;
    this.#collectionCreations = new Map();
    // Configuration runs in the background and nothing awaits it, so a failure must be logged here or it
    // would escape as an unhandled rejection. Writes do not depend on it succeeding.
    void this.#configure().catch(error => {
      this.#logger.error('Failed to configure collection', { collectionName: this.#collection.name, error: toLoggableError(error) });
    });
  }

  #getDb: () => Promise<Db>;
  #registerSession?: (session: ClientSession) => () => void;
  #collectionNames: Promise<Set<string>>;
  /**
   * In-flight `createCollection` calls by name. On a brand-new database the background configuration and
   * the first writes all ask for the same missing collections at once; they must all await the one
   * creation, otherwise a caller can use (e.g. `collMod`) a collection that does not exist yet.
   */
  #collectionCreations: Map<string, Promise<Collection<Document>>>;
  #collection: MXDBCollection<RecordType>;
  #config: MXDBCollectionConfig;
  #logger: Logger;

  public get name() { return this.#collection.name; }

  public get collection() { return this.#collection; }

  public async get(id: string): Promise<RecordType | undefined>;
  public async get(ids: string[]): Promise<RecordType[]>;
  @bind
  public async get(ids: string | string[]): Promise<RecordType | RecordType[] | undefined> {
    const collection = await this.#getCollection();
    const isArray = Array.isArray(ids);
    const justIds = (isArray ? ids : [ids]) as any[];
    const docs = (await collection.find({ _id: { $in: justIds } }).toArray()).mapWithoutNull(dbUtils.deserialize);
    return isArray ? docs : docs[0];
  }

  public async getAudit(id: string): Promise<ServerAuditOf<RecordType> | undefined>;
  public async getAudit(ids: string[]): Promise<ServerAuditOf<RecordType>[]>;
  @bind
  public async getAudit(ids: string | string[]): Promise<ServerAuditOf<RecordType> | ServerAuditOf<RecordType>[] | undefined> {
    const collection = await this.#getAuditCollection();
    const isArray = Array.isArray(ids);
    const justIds = (isArray ? ids : [ids]) as any[];
    const docs = (await collection.find({ _id: { $in: justIds } }).toArray()).mapWithoutNull(dbUtils.deserialize) as ServerAuditOf<RecordType>[];
    return isArray ? docs : docs[0];
  }

  /**
   * Cheap projection of the stored `_meta` for the given ids — the content hash (and audit anchor) WITHOUT
   * deserialising the whole record. Used by the C2S sync meta fast-path to confirm a client is already
   * up to date by comparing hashes. Docs with no stored `_meta.hash` (e.g. written before this existed)
   * are omitted, so the caller falls back to a full retrieve for them.
   */
  @bind
  public async getMeta(ids: string[]): Promise<{ id: string; hash: string; lastAuditEntryId?: string }[]> {
    if (ids.length === 0) return [];
    const collection = await this.#getCollection();
    const docs = await collection.find({ _id: { $in: ids as any[] } }, { projection: { _meta: 1 } }).toArray();
    const result: { id: string; hash: string; lastAuditEntryId?: string }[] = [];
    for (const doc of docs) {
      const meta = (doc as { _meta?: { hash?: string; lastAuditEntryId?: string } })._meta;
      if (meta?.hash == null) continue;
      result.push({ id: String(doc._id), hash: meta.hash, lastAuditEntryId: meta.lastAuditEntryId });
    }
    return result;
  }

  @bind
  public async find(filters: DataFilters<RecordType>): Promise<RecordType | undefined> {
    const collection = await this.#getCollection();
    const mongoFilters = this.#parseFilters(filters);
    const doc = await collection.findOne(mongoFilters ?? {});
    if (doc == null) return;
    return dbUtils.deserialize(doc);
  }

  @bind
  public async query(request?: QueryProps<RecordType>): Promise<DataResponse<RecordType>> {
    const collection = await this.#getCollection();
    request = this.#formatRequest(request);
    if (request == null) {
      const startTime = performance.now();
      const rawDocs = await collection.find().sort({ $natural: 1 }).toArray();
      const endTime = performance.now();
      if (endTime - startTime >= slowQueryThreshold) this.#logger.warn('Slow query (full scan)', {
        collectionName: collection.collectionName,
        durationMs: Math.round(endTime - startTime),
        recordCount: rawDocs.length,
      });
      const data = rawDocs.mapWithoutNull(dbUtils.deserialize);
      return { data, total: data.length };
    } else {
      const filters = request.filters != null && Object.keys(request.filters).length > 0 ? (() => {
        const startTime = performance.now();
        const result = this.#parseFilters(request!.filters);
        const endTime = performance.now();
        if (endTime - startTime >= slowFilterParseThreshold) this.#logger.warn('Slow filter parse', {
          collectionName: collection.collectionName,
          durationMs: Math.round(endTime - startTime),
          filterKeyCount: Object.keys(request!.filters ?? {}).length,
        });
        return result;
      })() : undefined;

      const offset = request.pagination?.offset ?? undefined;
      const limit = request.pagination?.limit;
      const sort = this.#parseSorts(request.sorts);
      const startTime = performance.now();
      const rawDocs = await collection.find(filters ?? {}, { sort: withStableOrder(sort), skip: offset, limit }).toArray();
      const endTime = performance.now();
      if (endTime - startTime >= slowQueryThreshold) this.#logger.warn('Slow query', {
        collectionName: collection.collectionName,
        durationMs: Math.round(endTime - startTime),
        recordCount: rawDocs.length,
        hasFilters: filters != null,
        hasSort: sort != null,
        limit,
        offset,
      });
      const data = rawDocs.mapWithoutNull(dbUtils.deserialize);
      let total = data.length;
      if (request.getAccurateTotal === true) total = await collection.countDocuments(filters);
      return { data, total, offset, limit };
    }
  }

  @bind
  public async getAll(): Promise<RecordType[]> {
    const collection = await this.#getCollection();
    return (await collection.find().toArray()).mapWithoutNull(dbUtils.deserialize);
  }

  public async upsert(record: RecordType, props?: UpsertProps): Promise<void>;
  public async upsert(records: RecordType[], props?: UpsertProps): Promise<void>;
  @bind
  public async upsert(records: RecordType | RecordType[], { resetAudit = false }: UpsertProps = {}): Promise<void> {
    const collection = await this.#getCollection();
    records = Array.isArray(records) ? records : [records];
    if (records.length === 0) return;
    const existingRecords = await this.get(records.ids());
    if (!resetAudit) {
      records = records.filter(record => {
        const existing = existingRecords.findById(record.id);
        return existing == null || !is.deepEqual(existing, record);
      });
      if (records.length === 0) return;
    }
    // Only records that are actually changing reach the hook; it may amend them before they are written.
    records = await runBeforeUpsertHook({ collection: this.#collection, records, existingRecords });
    const docs = await Promise.all(records.map(record => dbUtils.serializeWithMeta(record)));
    const result = await collection.bulkWrite(records.map((record, index) => ({ replaceOne: { replacement: docs[index]!, filter: { _id: record.id as any }, upsert: true } })));
    if (!result.isOk()) throw new InternalError('Bulk write failed - result is not as expected');
    const upsertedCount = result.matchedCount + result.upsertedCount;
    if (upsertedCount !== records.length) throw new InternalError(`Upsert failed - expected ${records.length}, got ${upsertedCount}`);
    if (this.#config.disableAudit !== true) {
      void this.#upsertAudit(existingRecords, records, { resetAudit }).catch(err => {
        this.#logger.error('Audit upsert failed', { error: String((err as any)?.message ?? err) });
      });
    }
  }

  public async remove(id: string, props?: DeleteProps<RecordType>): Promise<void>;
  public async remove(ids: string[], props?: DeleteProps<RecordType>): Promise<void>;
  @bind
  public async remove(ids: string | string[], { clearAudit = false, deleteSnapshots: passedSnapshots }: DeleteProps<RecordType> = {}): Promise<void> {
    const collection = await this.#getCollection();
    ids = Array.isArray(ids) ? ids : [ids];
    // Runs while the records are still stored, so the hook can read what is about to be deleted.
    await runBeforeDeleteHook({ collection: this.#collection, recordIds: ids, getStoredIds: async idsToCheck => (await this.get(idsToCheck)).ids() });

    let deleteSnapshots: { [recordId: string]: RecordType } | undefined = passedSnapshots;
    if (this.#config.disableAudit !== true && !clearAudit && deleteSnapshots == null) {
      const fetched = await this.get(ids);
      deleteSnapshots = Object.fromEntries(fetched.map(r => [r.id, r] as const));
    }

    const result = await collection.deleteMany({ _id: { $in: ids as any[] } });
    if (!result.acknowledged) throw new InternalError('Delete failed');
    if (this.#config.disableAudit !== true) this.#deleteAudit(ids, { clearAudit, deleteSnapshots });
  }

  @bind
  public async distinct({ field, filters, sorts }: DistinctProps<RecordType>): Promise<RecordType[]> {
    const collection = await this.#getCollection();
    const mongoFilters = this.#parseFilters(filters);
    const mongoSorts = this.#parseSorts(sorts);
    const records = await collection.aggregate<WithId<MongoDocOf<RecordType>>>([
      mongoFilters == null ? undefined : { $match: mongoFilters },
      { $group: { doc: { $first: '$$ROOT' }, _id: `$${field.toString()}` } },
      { $replaceRoot: { newRoot: '$doc' } },
      mongoSorts == null ? undefined : { $sort: mongoSorts },
    ].removeNull()).toArray();
    return records.mapWithoutNull(dbUtils.deserialize);
  }

  @bind
  public async count(): Promise<number> {
    const collection = await this.#getCollection();
    return await collection.countDocuments();
  }

  @bind
  public async clear() {
    const collection = await this.#getCollection();
    const extensions = getCollectionExtensions(this.#collection);
    await extensions?.onBeforeClear?.({ collectionName: this.name });
    await collection.deleteMany();
    if (this.#config.disableAudit !== true) this.#clearAudit();
    await extensions?.onAfterClear?.({ collectionName: this.name });
  }

  /**
   * Per-record transactional writes with per-record retry.
   *
   * Each record (upsert or delete) is written in its own MongoDB transaction so a
   * permanent failure on one record does not abort the others. Transient failures
   * are retried up to SYNC_MAX_RETRIES times with exponential backoff.
   *
   * Returns a result per id — `error` is set for permanently failed records.
   */
  public async sync({ updated, updatedAudits, removedIds }: DbCollectionSyncProps<RecordType>): Promise<SyncWriteResult[]> {
    const db = await this.#getDb();

    // Per-record upserts — run in parallel. Each record owns its own session and
    // transaction; the inner try/catch MUST resolve to a SyncWriteResult rather than
    // reject so a single bad record does not fail the entire batch.
    const upsertResults = await Promise.all(updated.map(async (record): Promise<SyncWriteResult> => {
      const recordSyncT0 = performance.now();
      const audit = updatedAudits.find(a => a.id === record.id);
      const session = db.client.startSession();
      const unregister = this.#registerSession?.(session);
      let txnAttempts = 0;
      let lastWriteRecordsMs = 0;
      let lastWriteAuditMs = 0;
      try {
        await this.#withRecordRetry(record.id, async () => {
          const wtT0 = performance.now();
          await session.withTransaction(async () => {
            txnAttempts += 1;
            const writeRecT0 = performance.now();
            await this.#writeRecords([record], session, new Map([[record.id, audit ? auditor.getLastEntryId(audit) : undefined]]));
            lastWriteRecordsMs = Math.round(performance.now() - writeRecT0);
            if (audit) {
              const writeAudT0 = performance.now();
              await this.#writeAuditRecords([audit], session);
              lastWriteAuditMs = Math.round(performance.now() - writeAudT0);
            }
          });
          const wtMs = Math.round(performance.now() - wtT0);
          if (wtMs >= 2_000 || txnAttempts > 1) {
            this.#logger.warn('[sync] slow/retried upsert txn', { collection: this.#collection.name, recordId: record.id, attempts: txnAttempts, wtMs, writeRecMs: lastWriteRecordsMs, writeAudMs: lastWriteAuditMs });
          }
        });
        const recordSyncMs = Math.round(performance.now() - recordSyncT0);
        if (recordSyncMs >= 2_000) {
          this.#logger.warn('[sync] slow upsert', { collection: this.#collection.name, recordId: record.id, durationMs: recordSyncMs, txnAttempts });
        }
        return { id: record.id };
      } catch (err) {
        this.#logger.error('Permanent write failure (upsert)', {
          collectionName: this.#collection.name,
          recordId: record.id,
          txnAttempts,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return { id: record.id, error: err instanceof Error ? err.message : String(err) };
      } finally {
        unregister?.();
        const endT0 = performance.now();
        await session.endSession();
        const endMs = Math.round(performance.now() - endT0);
        if (endMs >= 500) this.#logger.warn('[sync] slow session.endSession (upsert)', { recordId: record.id, ms: endMs });
      }
    }));

    // Per-record deletes — same parallel pattern. Sequential after upserts so that if
    // the same id accidentally appears in both lists (shouldn't, by contract) the
    // delete still lands last.
    const liveCollection = await this.#getCollection();
    const deleteResults = await Promise.all(removedIds.map(async (id): Promise<SyncWriteResult> => {
      const deleteSyncT0 = performance.now();
      const audit = updatedAudits.find(a => a.id === id);
      const session = db.client.startSession();
      const unregister = this.#registerSession?.(session);
      let txnAttempts = 0;
      try {
        await this.#withRecordRetry(id, async () => {
          const wtT0 = performance.now();
          await session.withTransaction(async () => {
            txnAttempts += 1;
            const doc = await liveCollection.findOne({ _id: id as any }, { session });
            const live = doc == null ? undefined : (dbUtils.deserialize(doc) as RecordType);
            await liveCollection.deleteOne({ _id: id as any }, { session });
            if (audit) {
              await this.#writeAuditRecords([audit], session, {
                deleteSnapshots: live != null ? { [id]: live } : undefined,
              });
            }
          });
          const wtMs = Math.round(performance.now() - wtT0);
          if (wtMs >= 2_000 || txnAttempts > 1) {
            this.#logger.warn('[sync] slow/retried delete txn', { collection: this.#collection.name, recordId: id, attempts: txnAttempts, wtMs });
          }
        });
        const deleteSyncMs = Math.round(performance.now() - deleteSyncT0);
        if (deleteSyncMs >= 2_000) {
          this.#logger.warn('[sync] slow delete', { collection: this.#collection.name, recordId: id, durationMs: deleteSyncMs, txnAttempts });
        }
        return { id };
      } catch (err) {
        this.#logger.error('Permanent write failure (delete)', {
          collectionName: this.#collection.name,
          recordId: id,
          txnAttempts,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return { id, error: err instanceof Error ? err.message : String(err) };
      } finally {
        unregister?.();
        const endT0 = performance.now();
        await session.endSession();
        const endMs = Math.round(performance.now() - endT0);
        if (endMs >= 500) this.#logger.warn('[sync] slow session.endSession (delete)', { recordId: id, ms: endMs });
      }
    }));

    return [...upsertResults, ...deleteResults];
  }

  /** Retry a per-record write for transient I/O failures with exponential backoff. */
  async #withRecordRetry(recordId: string, fn: () => Promise<void>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const attemptT0 = performance.now();
      try {
        await fn();
        return;
      } catch (err) {
        const attemptMs = Math.round(performance.now() - attemptT0);
        // Extract as much detail as possible — plain `err` serialises to `{}` for many
        // Mongo errors because the enumerable fields aren't the useful ones.
        const errAny = err as any;
        const errDetails = {
          name: errAny?.name,
          message: errAny?.message ?? String(err),
          code: errAny?.code,
          codeName: errAny?.codeName,
          errorLabels: errAny?.errorLabels,
          hasErrorLabel: typeof errAny?.hasErrorLabel === 'function'
            ? { TransientTransactionError: errAny.hasErrorLabel('TransientTransactionError'), UnknownTransactionCommitResult: errAny.hasErrorLabel('UnknownTransactionCommitResult') }
            : undefined,
          stack: errAny?.stack,
        };
        // Session-ended errors are NOT retryable. They occur when graceful shutdown's
        // drain timeout fires `session.endSession()` on in-flight transactions: every
        // parallel `sync()` call wakes up to find its session dead. Because `startSession`
        // is called once outside this retry loop, retrying with the same dead session
        // would fail immediately for all 20 attempts and waste ~2s of shutdown deadline.
        // Throw immediately so the action surfaces the error to the client; the C2S
        // pipeline will resend on reconnect. (Observed in stress logs as
        // "MongoBulkWriteError: Cannot use a session that has ended" floods at the exact
        // moment the server starts force-aborting stuck sessions during restart.)
        const isSessionEnded = errAny?.name === 'MongoExpiredSessionError'
          || /Cannot use a session that has ended/i.test(String(errAny?.message ?? ''));
        if (isSessionEnded) {
          this.#logger.warn('Session ended mid-write — not retryable (server shutting down?)', {
            collectionName: this.#collection.name, recordId, ...errDetails,
          });
          throw err;
        }
        if (attempt >= SYNC_MAX_RETRIES) {
          this.#logger.error('Final transient write failure after all retries', {
            collectionName: this.#collection.name, recordId, attempts: attempt, attemptMs, ...errDetails,
          });
          throw err;
        }
        const delayMs = Math.min(SYNC_RETRY_MAX_DELAY_MS, SYNC_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        this.#logger.warn('Transient write failure — retrying', {
          collectionName: this.#collection.name, recordId,
          attempt, maxAttempts: SYNC_MAX_RETRIES, attemptMs, nextRetryMs: delayMs,
          ...errDetails,
        });
        await new Promise<void>(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  #parseFilters(filters: DataFilters<RecordType> | undefined) {
    if (filters == null) return undefined;
    return toMongoFilterValue(filters) as any;
  }

  /**
   * Converts requested sorts into a MongoDB sort document (`{ field: 1 | -1 }`). A document — rather than
   * the driver's tuple-array form — is required because the same spec feeds both `find()` and an
   * aggregation `$sort` stage, and `$sort` only accepts a document with numeric directions.
   */
  #parseSorts(sorts: DataSorts<RecordType> | undefined): MongoSortSpec | undefined {
    const strictSorts = DataSorts.toArray(sorts);
    if (strictSorts.length === 0) return;
    return Object.fromEntries(strictSorts.map(([field, direction]) => [
      field === 'id' ? '_id' : String(field),
      direction === 'desc' ? SORT_DESCENDING : SORT_ASCENDING,
    ]));
  }

  async #getCollectionByName<R extends Record = RecordType>(name: string): Promise<Collection<MongoDocOf<R>>> {
    const db = await this.#getDb();
    const names = await this.#collectionNames;
    if (names.has(name)) return db.collection<MongoDocOf<R>>(name);
    const creation = this.#collectionCreations.get(name) ?? this.#createCollection(db, names, name);
    return await creation as unknown as Collection<MongoDocOf<R>>;
  }

  /**
   * Starts the single shared creation of a collection. The name is only recorded as existing once creation
   * succeeds; on failure the in-flight entry is dropped so a later caller retries rather than reusing the failure.
   */
  #createCollection(db: Db, names: Set<string>, name: string): Promise<Collection<Document>> {
    const creation = (async () => {
      try {
        const collection = await this.#createOrGetExistingCollection(db, name);
        names.add(name);
        return collection;
      } finally {
        this.#collectionCreations.delete(name);
      }
    })();
    this.#collectionCreations.set(name, creation);
    return creation;
  }

  /** The start-up list of collection names is a snapshot, so another process may have created it since. */
  async #createOrGetExistingCollection(db: Db, name: string): Promise<Collection<Document>> {
    try {
      return await db.createCollection(name);
    } catch (error) {
      if ((error as { code?: unknown }).code !== NAMESPACE_EXISTS_ERROR_CODE) throw error;
      return db.collection(name);
    }
  }

  async #getCollection() {
    return this.#getCollectionByName(this.#collection.name);
  }

  async #getAuditCollection() {
    return this.#getCollectionByName<ServerAuditOf<RecordType>>(`${this.#collection.name}_sync`);
  }

  /** Collects auditor warnings/errors into `sink` for corruption detection. Debug/info/silly are no-ops. */
  #auditLoggerThatCaptures(sink: string[]): Logger {
    const add = (msg: string) => {
      sink.push(msg);
    };
    const noop = () => { /* debug/info/silly are not corruption signals */ };
    const nest = (): Logger =>
      ({
        warn: add,
        info: noop,
        debug: noop,
        error: add,
        silly: noop,
        createSubLogger: nest,
      }) as unknown as Logger;
    return nest();
  }

  /** Maps auditor diagnostics to structured error logs for a record. */
  #auditLoggerAsStructuredError(recordId: string, label: string): Logger {
    const emit = (msg: string) => {
      this.#logger.error(label, { recordId, msg });
    };
    const nest = (): Logger =>
      ({
        warn: emit,
        info: emit,
        debug: emit,
        error: emit,
        silly: () => {},
        createSubLogger: nest,
      }) as unknown as Logger;
    return nest();
  }

  /** Forwards auditor warn/error/debug/info to the collection logger (replay, isAudit, merge diagnostics). */
  #auditLoggerForwarding(recordId: string): Logger {
    const emit = (level: 'warn' | 'error' | 'debug' | 'info') => (msg: string) => {
      this.#logger[level]('auditor', { recordId, msg });
    };
    const nest = (): Logger =>
      ({
        warn: emit('warn'),
        error: emit('error'),
        debug: emit('debug'),
        info: emit('info'),
        silly: () => {},
        createSubLogger: nest,
      }) as unknown as Logger;
    return nest();
  }

  async #upsertAudit(existingRecords: RecordType[], records: RecordType[], { resetAudit = false }: UpsertProps = {}) {
    const recordIds = records.ids();
    const existingAuditRecords = await this.#getAuditRecords(recordIds);
    const newAuditRecords = records.mapWithoutNull(record => {
      if (resetAudit) return auditor.createAuditFrom(record);

      let existingAuditRecord: AnyAuditOf<RecordType> | undefined = existingAuditRecords.findById(record.id);
      const existingRecord = existingRecords.findById(record.id);

      if (existingRecord != null && existingAuditRecord != null) {
        const auditErrors: string[] = [];
        const existingRecordFromAudit = auditor.createRecordFrom(
          existingAuditRecord,
          existingRecord ?? undefined,
          this.#auditLoggerThatCaptures(auditErrors),
        );

        if (auditErrors.length > 0) {
          this.#logger.warn('Audit replay had issues — resetting audit from current record', {
            recordId: record.id,
            errors: auditErrors.slice(0, 3),
          });
          // Instead of skipping the audit entirely, reset to a fresh audit based
          // on the current record so subsequent updates can be tracked correctly.
          existingAuditRecord = auditor.createAuditFrom(existingRecord);
        } else if (!is.deepEqual(existingRecordFromAudit, existingRecord)) {
          existingAuditRecord = auditor.updateAuditWith(
            existingRecord,
            existingAuditRecord,
            existingRecordFromAudit ?? undefined,
            this.#auditLoggerAsStructuredError(record.id, 'Audit reconcile failed'),
          );
        }

        if (is.deepEqual(existingRecord, record)) return;
      }

      if (existingAuditRecord == null) return auditor.createAuditFrom(record);
      const currentRecord = auditor.createRecordFrom(
        existingAuditRecord,
        existingRecords.findById(record.id) ?? undefined,
        this.#auditLoggerForwarding(record.id),
      );
      return auditor.updateAuditWith(
        record,
        existingAuditRecord,
        currentRecord ?? undefined,
        this.#auditLoggerAsStructuredError(record.id, 'Audit update failed'),
      );
    });
    await this.#writeAuditRecords(newAuditRecords);
  }

  async #deleteAudit(ids: string[], { clearAudit = false, deleteSnapshots }: DeleteProps<RecordType> = {}) {
    const existingAuditRecords = await this.#getAuditRecords(ids);
    if (clearAudit) {
      const collection = await this.#getAuditCollection();
      await collection.deleteMany({ _id: { $in: ids } });
    } else {
      const newAuditRecords = existingAuditRecords.map(auditRecord => auditor.delete(auditRecord));
      await this.#writeAuditRecords(newAuditRecords, undefined, { deleteSnapshots });
    }
  }

  async #clearAudit() {
    const collection = await this.#getAuditCollection();
    await collection.deleteMany();
  }

  #dropIndexIfNotRequired(collection: Collection<MongoDocOf<RecordType>>, indexes: MXDBCollectionIndex<RecordType>[]) {
    const indexNames = indexes.map(index => index.name);
    return async (existingIndex: IndexDescriptionInfo) => {
      const indexName = existingIndex.name;
      if (indexName == null || indexName === '_id_') return;
      if (indexNames.includes(indexName)) return;
      await collection.dropIndex(indexName);
    };
  }

  #setupIndexOn(collection: Collection<MongoDocOf<RecordType>>, existingIndexes: IndexDescriptionInfo[]) {
    return async (index: MXDBCollectionIndex<RecordType>) => {
      const existingIndex = existingIndexes.find(info => info.name === index.name);
      if (existingIndex != null) {
        const isSame = (existingIndex.sparse === true) === (index.isSparse === true) && (existingIndex.unique === true) === (index.isUnique === true);
        if (isSame) return;
        await collection.dropIndex(index.name);
      }
      await collection.createIndex(index.fields as string[], { name: index.name, unique: index.isUnique === true, sparse: index.isSparse === true });
    };
  }

  async #enableChangeStreamPreAndPostImages(db: Db, collection: Collection<any>) {
    try {
      await db.command({ collMod: collection.collectionName, changeStreamPreAndPostImages: { enabled: true } });
    } catch (error) {
      throw new InternalError({
        message: `Unable to update change stream settings for "${collection.collectionName}" — ensure the user has Atlas Admin privileges.`,
        meta: { collectionName: collection.collectionName, cause: describeMongoError(error) },
      });
    }
  }

  async #configureIndexes(collection: Collection<MongoDocOf<RecordType>>) {
    const existingIndexes = await collection.indexes();
    const indexes = this.#config.indexes;
    await existingIndexes.forEachAsync(this.#dropIndexIfNotRequired(collection, indexes));
    await indexes.forEachAsync(this.#setupIndexOn(collection, existingIndexes));
  }

  async #configure() {
    const db = await this.#getDb();
    const collection = await this.#getCollection();
    await this.#enableChangeStreamPreAndPostImages(db, collection);
    if (this.#config.disableAudit !== true) {
      const auditCollection = await this.#getAuditCollection();
      await this.#enableChangeStreamPreAndPostImages(db, auditCollection);
    }
    await this.#configureIndexes(collection);
  }

  async #getAuditRecords(ids: string[]) {
    const collection = await this.#getAuditCollection();
    return (await collection.find({ _id: { $in: ids } }).toArray()).mapWithoutNull(dbUtils.deserialize) as ServerAuditOf<RecordType>[];
  }

  #getActingUserId(): string {
    try {
      const id = useAuthentication().user?.id;
      if (id != null && String(id).length > 0) return String(id);
    } catch {
      // No socket context (e.g. background job)
    }
    return '__mxdb_system__';
  }

  async #writeRecords(records: RecordType[], session?: ClientSession, lastAuditEntryIds?: Map<string, string | undefined>) {
    if (records.length === 0) return;
    const getColT0 = performance.now();
    const collection = await this.#getCollection();
    const getColMs = Math.round(performance.now() - getColT0);
    const bwT0 = performance.now();
    const docs = await Promise.all(records.map(record => dbUtils.serializeWithMeta(record, lastAuditEntryIds?.get(record.id))));
    await collection.bulkWrite(
      records.map((record, index) => ({ replaceOne: { replacement: docs[index]!, filter: { _id: record.id as any }, upsert: true } })),
      session ? { session } : undefined,
    );
    const bwMs = Math.round(performance.now() - bwT0);
    if (bwMs >= 1_000 || getColMs >= 500) {
      this.#logger.warn('[sync] slow writeRecords', { collection: this.#collection.name, count: records.length, getColMs, bulkWriteMs: bwMs });
    }
  }

  async #writeAuditRecords(
    records: AnyAuditOf<RecordType>[],
    session?: ClientSession,
    writeOpts?: { deleteSnapshots?: { [recordId: string]: RecordType | undefined } },
  ) {
    if (records.length === 0) return;
    const collection = await this.#getAuditCollection();
    const actingUserId = this.#getActingUserId();
    const serverAudits = records.map(a =>
      toServerAuditOf(a, actingUserId, {
        deleteSnapshots: writeOpts?.deleteSnapshots,
        logger: this.#logger,
      }),
    );
    const bwT0 = performance.now();
    try {
      await collection.bulkWrite(
        serverAudits.map(serverAudit => ({
          replaceOne: {
            replacement: dbUtils.serialize(serverAudit as unknown as RecordType) as MongoDocOf<ServerAuditOf<RecordType>>,
            filter: { _id: serverAudit.id as any },
            upsert: true,
          },
        })),
        session ? { session } : undefined,
      );
      const bwMs = Math.round(performance.now() - bwT0);
      if (bwMs >= 1_000) {
        this.#logger.warn('[sync] slow writeAuditRecords', { collection: this.#collection.name, count: records.length, bulkWriteMs: bwMs });
      }
    } catch (error) {
      const bwMs = Math.round(performance.now() - bwT0);
      this.#logger.warn('[sync] writeAuditRecords failed', {
        collection: this.#collection.name, count: records.length, bulkWriteMs: bwMs,
        error: (error as any)?.message ?? String(error),
        code: (error as any)?.code,
        codeName: (error as any)?.codeName,
        errorLabels: (error as any)?.errorLabels,
      });
      throw new InternalError({ error, message: `Failed to write audit records for "${this.#collection.name}".` });
    }
  }

  #formatRequest(request?: QueryProps<RecordType>): QueryProps<RecordType> | undefined {
    if (request == null) return;
    if (request.pagination != null && Object.keys(request.pagination).length > 0) return request;
    if (request.sorts != null && Object.keys(request.sorts).length > 0) return request;
    if (request.filters != null && Object.keys(request.filters).length > 0) return request;
    if (request.getAccurateTotal === true) return request;
    if (request.serverHints != null && Object.values(request.serverHints).some(v => v !== undefined)) return request;
    return;
  }
}
