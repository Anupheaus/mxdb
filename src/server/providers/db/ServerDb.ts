import type { MongoDocOf, MXDBCollection } from '../../../common';
import type { ChangeStream, ChangeStreamDocument, ClientSession, Db } from 'mongodb';
import { MongoClient } from 'mongodb';
import { getCollectionExtensions } from '../../collections/extendCollection';
import { ServerDbCollection } from './ServerDbCollection';
import { ServerDbCollectionEvents } from './ServerDbCollectionEvents';
import type { ServerDbChangeEvent } from './server-db-models';
import { runInDbScope, setDb } from './DbContext';
import { captureAmbientLogger, runOutsideAnyConnection } from './runOutsideAnyConnection';
import { is, type Logger, type Record, type Unsubscribe } from '@anupheaus/common';
import { AsyncLocalStorage } from 'async_hooks';
import { createMongoCommandLogging } from './mongoCommandLogging';
import { classifyMongoFailure, type MongoFailureLike } from './classifyMongoError';

interface Props {
  mongoDbName: string;
  mongoDbUrl: string;
  collections: MXDBCollection[];
  logger: Logger;
  /** Idle window (ms) for change stream batching; passed to ServerDbCollectionEvents. Default 20. */
  changeStreamDebounceMs?: number;
  /** When false, the change-stream watcher is not started — for write-only callers (e.g. the controller
   *  writing into a tenant DB whose owning server already watches it). Default true. */
  watch?: boolean;
}

/**
 * Every live ServerDb, so {@link whenAllServerDbsConfigured} can wait for all of them.
 *
 * WeakRefs: the registry must never be the reason an instance stays alive. Entries whose target
 * has been collected are pruned when they are next walked.
 */
const liveServerDbs = new Set<WeakRef<ServerDb>>();

/**
 * Resolves once every ServerDb currently alive has finished configuring its collections.
 *
 * `ServerDb.whenConfigured()` only helps for an instance you hold, and the ones that race a
 * teardown generally are not reachable — consumers cache them in module-level maps, and the
 * per-connection pool holds others. Await this before dropping databases from outside mxdb, or the
 * drop cuts across DDL still in flight and Mongo refuses it with `DatabaseDropPending` or
 * `NamespaceNotFound`. Never rejects.
 */
export async function whenAllServerDbsConfigured(): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const ref of [...liveServerDbs]) {
    const db = ref.deref();
    if (db == null) { liveServerDbs.delete(ref); continue; }
    pending.push(db.whenConfigured());
  }
  await Promise.all(pending);
}

export class ServerDb {
  constructor(props: Props) {
    this.#mongoDbName = props.mongoDbName;
    this.#changeStreamDebounceMs = props.changeStreamDebounceMs;
    this.#watch = props.watch ?? true;
    this.#client = new MongoClient(props.mongoDbUrl);
    this.#logger = props.logger.createSubLogger('ServerDb');
    this.#hookLogger = captureAmbientLogger();
    this.#dbEvents = new Map();
    this.#setupEvents();
    this.#db = this.#connect();
    this.#collections = this.#setupCollections(props.collections);
    liveServerDbs.add(new WeakRef(this));
    this.#changeCallbacks = new Set();
  }

  #mongoDbName: string;
  #client: MongoClient;
  #collections: Map<string, ServerDbCollection<any>>;
  #logger: Logger;
  /** The logger ambient when this database was built, provided to the onAfter hooks (which run on an empty context). */
  #hookLogger: Logger | undefined;
  #db: Promise<Db>;
  #changeStream: ChangeStream | undefined;
  #dbEvents: Map<string, ServerDbCollectionEvents>;
  #changeCallbacks: Set<(event: ServerDbChangeEvent) => void>;
  #changeStreamDebounceMs: number | undefined;
  #watch: boolean;
  /** Fibonacci backoff for connect retries (ms); capped at 60s. Reset after a successful connect. */
  #connectBackoffMsPrev = 500;
  #connectBackoffMsCurr = 500;
  #connectAttempt = 0;
  #isClosing = false;
  #activeSessions = new Set<ClientSession>();

  /**
   * Track an active ClientSession so it can be force-aborted on graceful shutdown.
   * Critical for preventing the next-restarted server from inheriting Mongo document
   * locks held by transactions that were in-flight when the old server died.
   * Returns an unregister callback to be called in a `finally`.
   */
  public registerSession(session: ClientSession): () => void {
    this.#activeSessions.add(session);
    return () => { this.#activeSessions.delete(session); };
  }

  /** True once `close()` has been entered. Used by callers (e.g. action handlers) to
   *  short-circuit work that would otherwise spin up new Mongo sessions during shutdown. */
  public get isClosing(): boolean { return this.#isClosing; }

  /**
   * Instant shutdown. No drain.
   *
   * Rationale: any in-flight write that hasn't been acknowledged to the client is still
   * sitting in that client's C2S queue — it will be resent on reconnect, so aborting it
   * mid-flight is not data loss. Draining to "let writes commit" was costing 4–6 s per
   * restart and the new sessions kept arriving during the drain anyway (clients still
   * firing sync requests at a server that's about to die), so the drain rarely emptied
   * `#activeSessions` and almost always force-aborted at the deadline.
   *
   * The new flow:
   *  1. Flip `#isClosing` so the action handler refuses new sync requests up-front (those
   *     would otherwise call `db.client.startSession()` mid-shutdown).
   *  2. Close the change stream (it holds an open cursor on the Mongo client).
   *  3. Force-abort every active session in parallel — no awaiting individual abort futures,
   *     no drain. Each `endSession()` is fire-and-forget; failures are ignored because the
   *     session may already be torn down by the client close that follows.
   *  4. `MongoClient.close(true)` to terminate the TCP pool. Force=true so it does not
   *     wait on operations.
   */
  /**
   * Resolves once every collection's background configuration has settled (see
   * `ServerDbCollection.whenConfigured`). Never rejects.
   *
   * Await this before dropping the underlying database from outside this instance — otherwise the
   * drop races DDL that is still in flight and Mongo refuses it with `DatabaseDropPending` or
   * `NamespaceNotFound`, leaving the collections half-configured.
   */
  public async whenConfigured(): Promise<void> {
    await Promise.all([...this.#collections.values()].map(collection => collection.whenConfigured));
  }

  public async close(): Promise<void> {
    if (this.#isClosing) return;
    this.#isClosing = true;
    // Let the background configuration finish first: force-closing the client underneath it threw
    // MongoClientClosedError from work nothing was awaiting, which is why callers avoided close().
    await this.whenConfigured();
    const sessionCount = this.#activeSessions.size;
    this.#logger.info(`[ServerDb] close.begin activeSessions=${sessionCount}`);
    // Snapshot + clear sessions before aborting so any concurrent unregister() is a no-op.
    const sessions = [...this.#activeSessions];
    this.#activeSessions.clear();
    // Fire-and-forget abort + endSession for every session. We do NOT await — these calls
    // can hang on the network when the Mongo client is mid-teardown, and we are about to
    // force-close the client anyway, which will reject any outstanding session ops.
    for (const session of sessions) {
      try { if (session.inTransaction()) void session.abortTransaction().catch(() => { /* already aborting */ }); }
      catch { /* session may already be ending */ }
      try { void session.endSession().catch(() => { /* already ended */ }); }
      catch { /* already ended */ }
    }
    // Close the change stream BEFORE the client — it owns a long-lived cursor that would
    // otherwise hold the client open and inflate `client.close()` latency.
    try { await this.#changeStream?.close(); } catch { /* already closing */ }
    try { await this.#client.close(true); } catch (error) {
      this.#logger.warn('[ServerDb] close — MongoClient.close threw', { error: String((error as any)?.message ?? error) });
    }
    this.#logger.info(`[ServerDb] close.done abortedSessions=${sessionCount}`);
  }

  public use<RecordType extends Record>(collectionName: string) {
    return this.#collections.get(collectionName) as ServerDbCollection<RecordType>;
  }

  /** Expose the raw MongoDB Db for auth infrastructure (AuthCollection). */
  public getMongoDb(): Promise<Db> { return this.#db; }

  public async clear() {
    const db = await this.#db;
    const collections = await db.collections();
    for (const collection of collections) {
      await collection.drop();
    }
  }

  public onChange(callback: (event: ServerDbChangeEvent) => void): Unsubscribe {
    const scope = AsyncLocalStorage.snapshot();
    const callbackWrapper = (event: ServerDbChangeEvent) => scope(() => callback(event));
    this.#changeCallbacks.add(callbackWrapper);
    return () => this.#changeCallbacks.delete(callbackWrapper);
  }

  #resetConnectBackoff() {
    this.#connectBackoffMsPrev = 500;
    this.#connectBackoffMsCurr = 500;
    this.#connectAttempt = 0;
  }

  /** Next wait before retry; advances Fibonacci state (capped at 60s). */
  #nextConnectDelayMs(): number {
    const capMs = 60_000;
    const delayMs = Math.min(capMs, this.#connectBackoffMsCurr);
    const nextCurr = Math.min(capMs, this.#connectBackoffMsPrev + this.#connectBackoffMsCurr);
    this.#connectBackoffMsPrev = this.#connectBackoffMsCurr;
    this.#connectBackoffMsCurr = nextCurr;
    return delayMs;
  }

  #connect() {
    const attemptToConnect = async (): Promise<Db> => {
      this.#connectAttempt += 1;
      const attempt = this.#connectAttempt;
      const startedAt = Date.now();
      this.#logger.info(`[ServerDb] connect.begin (attempt ${attempt}) "${this.#mongoDbName}"`);
      try {
        await this.#client.connect();
        const connectMs = Date.now() - startedAt;
        this.#logger.info(`[ServerDb] connect.mongoClient.connected (attempt ${attempt}, ${connectMs}ms)`);
        const db = this.#client.db(this.#mongoDbName);
        this.#resetConnectBackoff();
        if (this.#watch) {
          this.#logger.info('[ServerDb] connect.db.handle ready — starting changeStream watcher');
          this.#startWatching(db);
        } else {
          this.#logger.info('[ServerDb] connect.db.handle ready — watch disabled, skipping changeStream watcher');
        }
        this.#logger.info(`[ServerDb] connect.done (total ${Date.now() - startedAt}ms)`);
        return db;
      } catch (error) {
        const delayMs = this.#nextConnectDelayMs();
        if (error instanceof Error) {
          this.#logger.error(
            `Failed to connect to database (attempt ${attempt}), retrying in ${delayMs}ms — could this be that this server's IP address is not configured on Atlas?`,
            { error: error.message, attempt, delayMs },
          );
        } else {
          this.#logger.error(`Failed to connect to database (attempt ${attempt}), retrying in ${delayMs}ms`, { error, attempt, delayMs });
        }
        await Promise.delay(delayMs);
        return attemptToConnect();
      }
    };
    return this.#db = attemptToConnect();
  }

  #setupEvents() {
    const client = this.#client;
    const logger = this.#logger;

    client.on('error', error => {
      logger.error('Database direct error', { error });
    });

    // Command events carry the command document (customer data), so they are logged by name, collection and
    // duration only — see createMongoCommandLogging.
    const { onCommandStarted, onCommandSucceeded, onCommandFailed } = createMongoCommandLogging(logger);
    client.on('commandStarted', onCommandStarted);
    client.on('commandFailed', onCommandFailed);
    client.on('commandSucceeded', onCommandSucceeded);

    client.on('connectionClosed', event => {
      if (this.#isClosing) return;
      logger.debug('Database connection closed unexpectedly', { event });
      this.#connect();
    });

    client.on('close', () => {
      this.#changeStream?.close();
      logger.debug('Database connection closed');
    });
  }

  #setupCollections(collections: MXDBCollection[]) {
    let collectionNamesPromise: Promise<Set<string>> | undefined;
    const getCollectionNames = async () => {
      if (collectionNamesPromise != null) return collectionNamesPromise;
      return collectionNamesPromise = (async () => {
        const db = await this.#db;
        const collectionNames = (await db.listCollections().toArray()).map(collection => collection.name);
        return new Set(collectionNames);
      })();
    };
    return new Map(collections.map(collection => [collection.name, new ServerDbCollection({ getDb: () => this.#db, collectionNames: getCollectionNames(), collection, logger: this.#logger, registerSession: (session: ClientSession) => this.registerSession(session) })]));
  }

  async #runExtensionHooksAfterChange(event: ServerDbChangeEvent) {
    const dbCollection = this.#collections.get(event.collectionName);
    if (dbCollection == null) return;
    const extensions = getCollectionExtensions(dbCollection.collection);
    if (extensions == null) return;

    const run = () => {
      if (event.type === 'delete') {
        return extensions.onAfterDelete?.({ recordIds: event.recordIds });
      }
      const insertedIds = event.type === 'insert' ? event.records.ids() : [];
      const updatedIds = event.type === 'update' ? event.records.ids() : [];
      return extensions.onAfterUpsert?.({ records: event.records, insertedIds, updatedIds });
    };

    try {
      // The driver emits the change in whatever context the change stream was started in: for a pooled tenant database,
      // the first connection routed to it. So the hooks run on an empty context chain, with no connection's socket or
      // signed-in user (sc-662), scoped to THIS database so useDb()/useCollection() reach the database that saw the
      // change (sc-621), and with the logger that was ambient when this database was built.
      await runOutsideAnyConnection({
        logger: this.#hookLogger,
        delegate: () => runInDbScope(() => {
          setDb(this);
          return Promise.resolve(run());
        }),
      });
    } catch (error) {
      this.#logger.error('Extension onAfter hook failed', { collectionName: event.collectionName, type: event.type, error });
    }
  }

  #changeStreamDocumentId(change: ChangeStreamDocument<MongoDocOf<Record>>): string | undefined {
    if ('documentKey' in change && change.documentKey != null && '_id' in change.documentKey) {
      return String((change.documentKey as { _id: unknown })._id);
    }
    if ('fullDocument' in change && change.fullDocument != null && '_id' in change.fullDocument) {
      return String((change.fullDocument as { _id: unknown })._id);
    }
    return undefined;
  }

  #startWatching(db: Db) {
    const isRestart = this.#changeStream != null;
    if (isRestart) this.#logger.warn('[ServerDb] changeStream restarting after the connection was lost');
    else this.#logger.info('[ServerDb] startWatching.begin');
    const changeStream = this.#changeStream = db.watch([{ $project: { something: false } }], { fullDocumentBeforeChange: 'whenAvailable' });
    // The driver resumes resumable errors itself and only emits 'error' when it could not, so a failure that is
    // not an expected transient one is an error: change notifications to clients have stopped.
    changeStream.on('error', err => {
      const level = classifyMongoFailure(err as MongoFailureLike);
      this.#logger[level]('[ServerDb] changeStream error', { error: String((err as any)?.message ?? err) });
    });
    changeStream.on('close', () => {
      if (this.#isClosing) this.#logger.info('[ServerDb] changeStream closed');
      else this.#logger.warn('[ServerDb] changeStream closed unexpectedly');
    });
    this.#logger.info('[ServerDb] startWatching.ready (listeners attached)');
    changeStream.on('change', change => {
      const collectionName: string | undefined = 'ns' in change && change.ns != null && 'coll' in change.ns ? change.ns.coll : undefined;
      const op = 'operationType' in change ? change.operationType : undefined;
      const documentId = this.#changeStreamDocumentId(change as ChangeStreamDocument<MongoDocOf<Record>>);

      if (is.blank(collectionName)) {
        this.#logger.silly('changeStream:ignore (no collection ns)', { operationType: op, documentId });
        return;
      }
      const collection = this.#collections.get(collectionName);
      if (collection == null) {
        this.#logger.silly('changeStream:ignore (collection not in ServerDb config)', { collectionName, operationType: op, documentId });
        return;
      }
      // Ignore changes where the full document is the same as the full document before change
      if ('fullDocument' in change && 'fullDocumentBeforeChange' in change && is.deepEqual(change.fullDocument, change.fullDocumentBeforeChange)) {
        this.#logger.silly('changeStream:ignore (fullDocument unchanged vs before)', { collectionName, operationType: op, documentId });
        return;
      }
      const validOperationType: ServerDbChangeEvent['type'] | undefined = ['create', 'insert'].includes(change.operationType)
        ? 'insert' : ['update', 'replace'].includes(change.operationType) ? 'update' : change.operationType === 'delete' ? 'delete' : undefined;
      if (validOperationType == null) {
        this.#logger.silly('changeStream:ignore (operationType not mapped)', { collectionName, operationType: op, documentId });
        return;
      }

      this.#logger.silly('changeStream:raw event → debounce batch', {
        collectionName,
        mappedType: validOperationType,
        operationType: op,
        documentId,
      });

      const key = `${collectionName}-${validOperationType}`;
      const events = this.#dbEvents.getOrSet(key, () => new ServerDbCollectionEvents({
        collectionName,
        callbacks: this.#changeCallbacks,
        operationType: validOperationType,
        debounceMs: this.#changeStreamDebounceMs,
        onAfterDispatch: event => this.#runExtensionHooksAfterChange(event),
      }));
      events.process(change as ChangeStreamDocument<MongoDocOf<Record>>);
    });

  }
}