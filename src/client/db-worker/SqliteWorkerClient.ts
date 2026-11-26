/* eslint-disable max-classes-per-file -- InlineRunner is co-located with SqliteWorkerClient for a single worker entry point. */
import { ulid } from 'ulidx';
import type { Logger } from '@anupheaus/common';
import type { WorkerRequestWithCorrelationId, WorkerResponse } from './worker-messages';

// ─── Inline (no-Worker) SQLite runner for Node.js / test environments ─────────

type InlineSqlite3 = any; // @sqlite.org/sqlite-wasm type (dynamic import)

let inlineSqlite3Promise: Promise<InlineSqlite3> | null = null;

async function getInlineSqlite3(): Promise<InlineSqlite3> {
  if (inlineSqlite3Promise == null) {
    inlineSqlite3Promise = (async () => {
      const { default: init } = await import('@sqlite.org/sqlite-wasm') as any;
      return init({ print: () => { /* suppress */ }, printErr: () => { /* suppress */ } });
    })();
  }
  return inlineSqlite3Promise;
}

class InlineRunner {
  #db: any = null;

  async open(_dbName: string, statements: string[]): Promise<void> {
    const sqlite3 = await getInlineSqlite3();
    if (this.#db) { this.#db.close(); this.#db = null; }
    this.#db = new sqlite3.oo1.DB(':memory:', 'ct');

    // Register REGEXP
    this.#db.createFunction('regexp', (_ctx: unknown, pattern: string, value: unknown) => {
      // Only text matches, as in MongoDB: RegExp.test would read a missing field as the text "null".
      if (typeof value !== 'string') return 0;
      try { return new RegExp(pattern).test(value) ? 1 : 0; } catch { return 0; }
    }, { arity: 2 });

    this.#db.transaction((tx: any) => {
      for (const sql of statements) tx.exec(sql);
    });
  }

  exec(sql: string, params?: unknown[]): void {
    if (!this.#db) throw new Error('Database not open');
    this.#db.exec({ sql, bind: params ?? [] });
  }

  execBatch(statements: Array<{ sql: string; params?: unknown[] }>): void {
    if (!this.#db) throw new Error('Database not open');
    this.#db.transaction((tx: any) => {
      for (const { sql, params } of statements) tx.exec({ sql, bind: params ?? [] });
    });
  }

  query(sql: string, params?: unknown[]): Record<string, unknown>[] {
    if (!this.#db) throw new Error('Database not open');
    const rows: Record<string, unknown>[] = [];
    this.#db.exec({ sql, bind: params ?? [], rowMode: 'object', callback: (r: any) => rows.push(r) });
    return rows;
  }

  queryMulti(queries: Array<{ sql: string; params?: unknown[] }>): Record<string, unknown>[][] {
    return queries.map(({ sql, params }) => this.query(sql, params));
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }
}

// ─── Mode detection ───────────────────────────────────────────────────────────

type ClientMode = 'inline' | 'shared' | 'dedicated';

function detectMode(): ClientMode {
  if (typeof Worker === 'undefined') return 'inline';
  if (typeof SharedWorker !== 'undefined') return 'shared';
  return 'dedicated';
}

// ─── SqliteWorkerClient ────────────────────────────────────────────────────────

/**
 * How long a new worker has to answer its first message (the SharedWorker's `connect`, a dedicated Worker's `ping`)
 * before it is given up on. Answering needs only the worker's script to have loaded, not SQLite or the database, so
 * this is generous; a worker whose script is fetched but never fetches its own imports (seen once in ~745 Vision E2E
 * starts) never answers at all.
 */
export const WORKER_START_TIMEOUT_MS = 8_000;
/** Workers started before the client gives up: the first, and one fresh one. */
const WORKER_START_ATTEMPTS = 2;
/** The SharedWorker every tab joins. A retry uses a new name, as the same name would join the same stuck instance. */
const SHARED_WORKER_NAME = 'mxdb-sqlite';

/**
 * The SQLite worker did not start, even after a fresh one was tried: every request of the client rejects with this.
 * The app should say so and offer a reload; nothing in this page will start it.
 */
export class SqliteWorkerStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteWorkerStartError';
  }
}

/** One worker did not start (no answer in time, or its script failed): a fresh one is tried. */
class WorkerDidNotStart extends Error { }

export interface SqliteWorkerClientOptions {
  /**
   * Raw 256-bit AES-GCM key bytes derived from WebAuthn PRF.
   * When provided the worker encrypts the OPFS database file at rest.
   * Omit for an unencrypted database (test / non-WebAuthn environments).
   */
  encryptionKey?: Uint8Array;
  /** Overrides {@link WORKER_START_TIMEOUT_MS} (milliseconds). */
  startTimeoutMs?: number;
  /** Told when a worker did not start and a fresh one is tried. */
  logger?: Logger;
}

/**
 * Main-thread proxy for the SQLite worker.
 *
 * Mode selection (auto-detected at construction time):
 *  - **shared**   SharedWorker — one SQLite instance for all tabs (preferred)
 *  - **dedicated** Dedicated Worker — one SQLite instance per tab (fallback for Cordova)
 *  - **inline**   No worker — runs SQLite in-process for Node.js / tests
 *
 * Start-up: the first request starts the worker and waits for it to answer a handshake, for at most
 * {@link WORKER_START_TIMEOUT_MS}. A worker that does not answer (or whose script fails) is dropped and ONE fresh worker
 * is tried; if that fails too, every request rejects with {@link SqliteWorkerStartError} instead of waiting for ever.
 *
 * Cross-tab reactivity: after any write, the SharedWorker broadcasts a
 * 'change-notification' to all other tabs. Register a handler via
 * `setOnExternalChange()` to be notified.
 */
export class SqliteWorkerClient {
  constructor(options?: SqliteWorkerClientOptions) {
    this.#encryptionKey = options?.encryptionKey;
    this.#startTimeoutMs = options?.startTimeoutMs ?? WORKER_START_TIMEOUT_MS;
    this.#logger = options?.logger;
    this.#mode = detectMode();
    if (this.#mode === 'inline') {
      this.#inlineRunner = new InlineRunner();
    }
  }

  #encryptionKey: Uint8Array | undefined;
  #startTimeoutMs: number;
  #logger: Logger | undefined;
  #mode: ClientMode;
  #worker: Worker | null = null;
  #sharedWorker: SharedWorker | null = null;
  #port: MessagePort | null = null;
  #portId = '';
  /** The start-up of the current worker: resolves once it has answered, rejects once every attempt has failed. */
  #started: Promise<void> | null = null;
  /** Fails the start-up attempt in progress (set only while one is). */
  #failStartAttempt: ((reason: string) => void) | null = null;
  #isUnloadDisconnectWired = false;
  #pending = new Map<string, { resolve(v: unknown): void; reject(e: unknown): void }>();
  #inlineRunner: InlineRunner | undefined;
  #onExternalChange: ((collectionName: string) => void) | null = null;

  // ─── Worker management ──────────────────────────────────────────────────────

  /** Register a callback invoked when another tab writes to a collection. */
  setOnExternalChange(handler: (collectionName: string) => void) {
    this.#onExternalChange = handler;
  }

  #handleMessage = ({ data }: MessageEvent<WorkerResponse | { type: string; collectionName?: string }>) => {
    // Change notifications from SharedWorker don't have a correlationId
    if ('type' in data && (data as any).type === 'change-notification') {
      this.#onExternalChange?.((data as any).collectionName ?? '');
      return;
    }
    const response = data as WorkerResponse;
    const pending = this.#pending.get(response.correlationId);
    if (pending == null) return;
    this.#pending.delete(response.correlationId);
    if (response.error != null) {
      pending.reject(new Error(response.error));
    } else {
      pending.resolve(response.result);
    }
  };

  #handleError = (ev: ErrorEvent) => {
    this.#failStartAttempt?.(`its script failed (${ev.message ?? 'no detail'})`);
    for (const [id, pending] of this.#pending) {
      pending.reject(new Error(ev.message ?? 'Worker error'));
      this.#pending.delete(id);
    }
  };

  /** Starts the worker once per client (until close), retrying once with a fresh worker. */
  #ensureStarted(): Promise<void> {
    this.#started ??= this.#start();
    return this.#started;
  }

  async #start(): Promise<void> {
    const problems: string[] = [];
    for (let attempt = 1; attempt <= WORKER_START_ATTEMPTS; attempt++) {
      try {
        await this.#startAttempt(attempt);
        return;
      } catch (error) {
        // A worker that answered with an error has started: that answer is the outcome, not a reason to retry.
        if (!(error instanceof WorkerDidNotStart)) throw error;
        problems.push(error.message);
        this.#discardWorker();
        if (attempt < WORKER_START_ATTEMPTS) {
          this.#logger?.warn('The SQLite worker did not start; starting a fresh one', { mode: this.#mode, attempt, problem: error.message });
        }
      }
    }
    throw new SqliteWorkerStartError(
      `The device's local database did not start: its SQLite ${this.#mode === 'shared' ? 'SharedWorker' : 'Worker'} `
      + `did not answer (${problems.map((problem, index) => `attempt ${index + 1}: ${problem}`).join('; ')}). `
      + 'Reload the app to try again.',
    );
  }

  /** Creates one worker and waits for its handshake: `connect` for the SharedWorker (it assigns the port id), `ping` otherwise. */
  #startAttempt(attempt: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const correlationId = ulid();
      const settle = (outcome: () => void) => {
        clearTimeout(timer);
        this.#failStartAttempt = null;
        this.#pending.delete(correlationId);
        outcome();
      };
      const timer = setTimeout(() => settle(() => reject(new WorkerDidNotStart(`no answer within ${this.#startTimeoutMs} ms`))), this.#startTimeoutMs);
      this.#failStartAttempt = reason => settle(() => reject(new WorkerDidNotStart(reason)));
      this.#pending.set(correlationId, {
        resolve: result => settle(() => {
          if (this.#mode === 'shared') this.#portId = result as string;
          resolve();
        }),
        reject: error => settle(() => reject(error)),
      });

      if (this.#mode === 'shared') {
        const port = this.#createSharedPort(attempt);
        port.postMessage({ type: 'connect', correlationId });
      } else {
        this.#createDedicatedWorker().postMessage({ type: 'ping', correlationId });
      }
    });
  }

  #createSharedPort(attempt: number): MessagePort {
    const name = attempt === 1 ? SHARED_WORKER_NAME : `${SHARED_WORKER_NAME}-retry-${attempt - 1}`;
    this.#sharedWorker = new SharedWorker(new URL('./sqlite-shared-worker.ts', import.meta.url), { type: 'module', name });
    this.#sharedWorker.onerror = () => this.#failStartAttempt?.('its script failed to load');
    const port = this.#sharedWorker.port;
    this.#port = port;
    port.addEventListener('message', this.#handleMessage as EventListener);
    port.start();
    this.#wireUnloadDisconnect();
    return port;
  }

  #createDedicatedWorker(): Worker {
    this.#worker = new Worker(new URL('./sqlite-worker.ts', import.meta.url), { type: 'module' });
    this.#worker.addEventListener('message', this.#handleMessage as EventListener);
    this.#worker.onerror = this.#handleError;
    return this.#worker;
  }

  /** Tell the SharedWorker to drop this tab's port when the page unloads (once per client). */
  #wireUnloadDisconnect(): void {
    if (this.#isUnloadDisconnectWired) return;
    this.#isUnloadDisconnectWired = true;
    globalThis.addEventListener?.('beforeunload', () => {
      if (this.#portId) {
        this.#port?.postMessage({ type: 'disconnect', portId: this.#portId });
      }
    }, { once: true });
  }

  /** Drops a worker that did not start, so the next attempt cannot receive its late answers. */
  #discardWorker(): void {
    if (this.#port != null) {
      this.#port.removeEventListener?.('message', this.#handleMessage as EventListener);
      this.#port.close?.();
    }
    this.#port = null;
    this.#sharedWorker = null;
    this.#portId = '';
    this.#worker?.terminate();
    this.#worker = null;
  }

  async #send<T = unknown>(request: WorkerRequestWithCorrelationId): Promise<T> {
    // Every request waits for the worker to have started (and rejects if it never does). In shared mode this is also
    // what creates the port, so a send that races ahead of open() can't dereference a null #port.
    await this.#ensureStarted();
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(request.correlationId, {
        resolve: v => resolve(v as T),
        reject,
      });
      if (this.#mode === 'shared') {
        this.#port!.postMessage(request);
      } else {
        this.#worker!.postMessage(request);
      }
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async open(dbName: string, statements: string[]): Promise<void> {
    if (this.#mode === 'inline') {
      return this.#inlineRunner!.open(dbName, statements);
    }
    await this.#send({ type: 'open', correlationId: ulid(), dbName, statements, encryptionKey: this.#encryptionKey });
    this.#flushWhenHidden();
  }

  /**
   * Persist the encrypted database's snapshot now if it has unflushed writes. The worker coalesces snapshots (sc-680);
   * every write is already in its write-ahead log before it is answered, so this only saves replaying that log on the
   * next open. It is called when the tab is hidden or unloads.
   */
  async flush(): Promise<void> {
    if (this.#mode === 'inline') return;
    await this.#send({ type: 'flush', correlationId: ulid() });
  }

  #isFlushWhenHiddenWired = false;

  /** Ask the worker to flush when this tab is hidden or unloads — the moments a tab may not come back. */
  #flushWhenHidden(): void {
    if (this.#isFlushWhenHiddenWired || this.#encryptionKey == null) return;
    this.#isFlushWhenHiddenWired = true;
    const flushQuietly = () => {
      // Best effort: the tab may be going away, and the worker logs its own failures and retries.
      void this.flush().catch(() => { /* the worker keeps the data in memory and flushes again later */ });
    };
    globalThis.addEventListener?.('pagehide', flushQuietly);
    globalThis.document?.addEventListener?.('visibilitychange', () => {
      if (globalThis.document?.visibilityState === 'hidden') flushQuietly();
    });
  }

  async exec(sql: string, params?: unknown[], collectionHint?: string): Promise<void> {
    if (this.#mode === 'inline') {
      this.#inlineRunner!.exec(sql, params);
      return;
    }
    await this.#send({ type: 'exec', correlationId: ulid(), sql, params, collectionHint });
  }

  async execBatch(
    statements: Array<{ sql: string; params?: unknown[] }>,
    collectionHint?: string,
  ): Promise<void> {
    if (this.#mode === 'inline') {
      this.#inlineRunner!.execBatch(statements);
      return;
    }
    await this.#send({ type: 'exec-batch', correlationId: ulid(), statements, collectionHint });
  }

  async query<T extends object = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    if (this.#mode === 'inline') {
      return this.#inlineRunner!.query(sql, params) as T[];
    }
    return this.#send<T[]>({ type: 'query', correlationId: ulid(), sql, params });
  }

  async queryMulti<T extends object = Record<string, unknown>>(
    queries: Array<{ sql: string; params?: unknown[] }>,
  ): Promise<T[][]> {
    if (this.#mode === 'inline') {
      return this.#inlineRunner!.queryMulti(queries) as T[][];
    }
    return this.#send<T[][]>({ type: 'query-multi', correlationId: ulid(), queries });
  }

  async close(): Promise<void> {
    if (this.#mode === 'inline') {
      this.#inlineRunner!.close();
      return;
    }
    // A worker never started has no database open; one that could not start has nothing to close either.
    if (this.#started == null) return;
    try {
      await this.#started;
    } catch {
      this.#started = null;
      return;
    }
    if (this.#mode === 'shared') {
      await this.#send({ type: 'close', correlationId: ulid() });
      if (this.#portId) {
        this.#port?.postMessage({ type: 'disconnect', portId: this.#portId });
      }
      this.#port?.close();
      this.#port = null;
      this.#sharedWorker = null;
      this.#portId = '';
      this.#started = null;
      return;
    }
    await this.#send({ type: 'close', correlationId: ulid() });
    this.#worker?.terminate();
    this.#worker = null;
    this.#started = null;
  }
}
