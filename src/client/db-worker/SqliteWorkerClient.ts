/* eslint-disable max-classes-per-file -- InlineRunner is co-located with SqliteWorkerClient for a single worker entry point. */
import { ulid } from 'ulidx';
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
    this.#db.createFunction('regexp', (_ctx: unknown, pattern: string, value: string) => {
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

export interface SqliteWorkerClientOptions {
  /**
   * Raw 256-bit AES-GCM key bytes derived from WebAuthn PRF.
   * When provided the worker encrypts the OPFS database file at rest.
   * Omit for an unencrypted database (test / non-WebAuthn environments).
   */
  encryptionKey?: Uint8Array;
}

/**
 * Main-thread proxy for the SQLite worker.
 *
 * Mode selection (auto-detected at construction time):
 *  - **shared**   SharedWorker — one SQLite instance for all tabs (preferred)
 *  - **dedicated** Dedicated Worker — one SQLite instance per tab (fallback for Cordova)
 *  - **inline**   No worker — runs SQLite in-process for Node.js / tests
 *
 * Cross-tab reactivity: after any write, the SharedWorker broadcasts a
 * 'change-notification' to all other tabs. Register a handler via
 * `setOnExternalChange()` to be notified.
 */
export class SqliteWorkerClient {
  constructor(options?: SqliteWorkerClientOptions) {
    this.#encryptionKey = options?.encryptionKey;
    this.#mode = detectMode();
    if (this.#mode === 'inline') {
      this.#inlineRunner = new InlineRunner();
    }
  }

  #encryptionKey: Uint8Array | undefined;
  #mode: ClientMode;
  #worker: Worker | null = null;
  #sharedWorker: SharedWorker | null = null;
  #port: MessagePort | null = null;
  #portId = '';
  #portIdReady: Promise<void> | null = null;
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
    for (const [id, pending] of this.#pending) {
      pending.reject(new Error(ev.message ?? 'Worker error'));
      this.#pending.delete(id);
    }
  };

  #ensureSharedPort(): Promise<void> {
    if (this.#portIdReady != null) return this.#portIdReady;

    this.#sharedWorker = new SharedWorker(
      new URL('./sqlite-shared-worker.ts', import.meta.url),
      { type: 'module', name: 'mxdb-sqlite' },
    );
    this.#port = this.#sharedWorker.port;
    this.#port.addEventListener('message', this.#handleMessage as EventListener);
    this.#port.start();

    // Wire disconnect on tab unload
    globalThis.addEventListener?.('beforeunload', () => {
      if (this.#portId) {
        this.#port?.postMessage({ type: 'disconnect', portId: this.#portId });
      }
    }, { once: true });

    this.#portIdReady = new Promise<void>((resolve, reject) => {
      const correlationId = ulid();
      this.#pending.set(correlationId, {
        resolve: portId => {
          this.#portId = portId as string;
          resolve();
        },
        reject,
      });
      this.#port!.postMessage({ type: 'connect', correlationId });
    });

    return this.#portIdReady;
  }

  #ensureWorker(): Worker {
    if (this.#worker == null) {
      this.#worker = new Worker(new URL('./sqlite-worker.ts', import.meta.url), { type: 'module' });
      this.#worker.addEventListener('message', this.#handleMessage as EventListener);
      this.#worker.onerror = this.#handleError;
    }
    return this.#worker;
  }

  async #send<T = unknown>(request: WorkerRequestWithCorrelationId): Promise<T> {
    // In shared mode the port is created lazily by open() → #ensureSharedPort(). Ensure it here
    // too so a send that races ahead of open() can't dereference a null #port — mirroring the
    // dedicated branch, which already self-heals via #ensureWorker(). #ensureSharedPort is
    // idempotent (returns the cached connect handshake).
    if (this.#mode === 'shared') await this.#ensureSharedPort();
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(request.correlationId, {
        resolve: v => resolve(v as T),
        reject,
      });
      if (this.#mode === 'shared') {
        this.#port!.postMessage(request);
      } else {
        this.#ensureWorker().postMessage(request);
      }
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async open(dbName: string, statements: string[]): Promise<void> {
    if (this.#mode === 'inline') {
      return this.#inlineRunner!.open(dbName, statements);
    }
    if (this.#mode === 'shared') {
      await this.#ensureSharedPort();
    }
    await this.#send({ type: 'open', correlationId: ulid(), dbName, statements, encryptionKey: this.#encryptionKey });
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
    if (this.#mode === 'shared') {
      await this.#send({ type: 'close', correlationId: ulid() });
      if (this.#portId) {
        this.#port?.postMessage({ type: 'disconnect', portId: this.#portId });
      }
      this.#port?.close();
      this.#port = null;
      this.#sharedWorker = null;
      this.#portId = '';
      this.#portIdReady = null;
      return;
    }
    await this.#send({ type: 'close', correlationId: ulid() });
    this.#worker?.terminate();
    this.#worker = null;
  }
}
