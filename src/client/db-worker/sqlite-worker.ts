/**
 * SQLite WASM Web Worker
 *
 * Owns the sqlite-wasm instance and OPFS file handle. All DB operations
 * run here; the main thread communicates via postMessage with correlation IDs.
 *
 * Environment detection:
 *  - Worker + OPFS available + encryptionKey provided → in-memory DB, persisted
 *    as an AES-GCM encrypted blob in OPFS (`${dbName}.enc`). The DB is
 *    serialised and re-encrypted after every write so indexes are fully intact.
 *  - Worker + OPFS available, no encryptionKey → OpfsDb (persistent, plain)
 *  - Otherwise (no OPFS, or Node.js/test) → in-memory DB (no persistence)
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { WorkerRequestWithCorrelationId, WorkerResponse } from './worker-messages';
import {
  isOpfsAvailable, flushEncrypted, openEncrypted, registerRegexp, databaseSizeBytes,
  acquireDbLock, releaseDbLock,
} from './sqlite-worker-shared';
import { createEncryptedFlushScheduler } from './encryptedFlushScheduler';
import type { Sqlite3, OO1Db, LockRef } from './sqlite-worker-shared';

// ─── State ────────────────────────────────────────────────────────────────────

let db: OO1Db | null = null;
let sqlite3: Sqlite3 | null = null;

// Per-database encryption state
let cryptoKey: CryptoKey | null = null;
let encryptedFileName = '';
// Name of the database currently open — makes `open` idempotent so a repeat open of the same
// database doesn't close+reopen it (which would briefly null `db` → "Database not open").
let openDbName = '';

// Exclusive Web Lock held for the lifetime of this open database.
// Prevents a second dedicated-worker tab from opening the same OPFS file.
const lockRef: LockRef = { release: null };

// Persisting the encrypted DB exports and encrypts all of it, so writes only mark it dirty and ONE coalesced flush runs
// at a time (sc-680). It reads the state current when it runs, so call flushNow() BEFORE switching or closing the DB.
const flushScheduler = createEncryptedFlushScheduler({
  flush: async () => {
    if (db == null || sqlite3 == null || cryptoKey == null) return;
    await flushEncrypted(sqlite3, db, cryptoKey, encryptedFileName);
  },
  onFlushFailed: error => {
    // The in-memory DB is intact and the flush is retried; only the OPFS copy is behind.
    // eslint-disable-next-line no-console -- the worker has no Logger (it cannot reach the app's); the worker console is its log
    console.error('[mxdb-worker] Encrypted flush failed — will retry', {
      encryptedFileName, dbSizeBytes: db == null ? 0 : databaseSizeBytes(db), error: error instanceof Error ? error.message : String(error),
    });
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function reply(correlationId: string, result: unknown) {
  const response: WorkerResponse = { correlationId, result };
  self.postMessage(response);
}

function replyError(correlationId: string, err: unknown) {
  const response: WorkerResponse = {
    correlationId,
    error: err instanceof Error ? err.message : String(err),
  };
  self.postMessage(response);
}

// ─── Operation handlers ───────────────────────────────────────────────────────

async function handleOpen(
  dbName: string,
  statements: string[],
  encryptionKey: Uint8Array | undefined,
  correlationId: string,
) {
  try {
    const acquired = await acquireDbLock(dbName, lockRef);
    if (!acquired) {
      replyError(correlationId, new Error(`Database "${dbName}" is already open in another tab. Only one tab can access this database when SharedWorker is unavailable.`));
      return;
    }

    if (!sqlite3) {
      sqlite3 = await (sqlite3InitModule as any)({
        print: () => { /* suppress */ },
        printErr: () => { /* suppress */ },
      });
    }

    // Already open with the same database — don't close+reopen (that briefly nulls `db`, so any
    // query in flight throws "Database not open"). Idempotently ensure the tables exist and reply.
    if (db && openDbName === dbName) {
      (db as any).transaction((tx: any) => {
        for (const sql of statements) tx.exec(sql);
      });
      reply(correlationId, null);
      return;
    }

    // A different database was open (e.g. user switched) — close it before opening the new one.
    if (db) {
      await flushScheduler.flushNow();
      flushScheduler.reset();
      db.close();
      db = null;
      cryptoKey = null;
      encryptedFileName = '';
      openDbName = '';
    }

    if (encryptionKey != null && encryptionKey.byteLength > 0) {
      const opened = await openEncrypted(sqlite3!, dbName, encryptionKey);
      db = opened.db;
      cryptoKey = opened.cryptoKey;
      encryptedFileName = opened.encryptedFileName;
    } else if (isOpfsAvailable() && sqlite3!.oo1.OpfsDb != null) {
      db = new sqlite3!.oo1.OpfsDb(`${dbName}.sqlite3`, 'ct');
    } else {
      db = new sqlite3!.oo1.DB(':memory:', 'ct');
    }

    registerRegexp(sqlite3!, db);

    (db as any).transaction((tx: any) => {
      for (const sql of statements) {
        tx.exec(sql);
      }
    });

    // Flush after DDL setup so the schema is persisted immediately
    if (cryptoKey) flushScheduler.markDirty();

    openDbName = dbName;
    reply(correlationId, null);
  } catch (err) {
    replyError(correlationId, err);
  }
}

async function handleExec(sql: string, params: unknown[] | undefined, correlationId: string) {
  try {
    if (!db || !sqlite3) throw new Error('Database not open');
    db.exec({ sql, bind: (params ?? []) as any });
    if (cryptoKey) flushScheduler.markDirty();
    reply(correlationId, null);
  } catch (err) {
    replyError(correlationId, err);
  }
}

async function handleExecBatch(
  statements: Array<{ sql: string; params?: unknown[] }>,
  correlationId: string,
) {
  try {
    if (!db || !sqlite3) throw new Error('Database not open');
    (db as any).transaction((tx: any) => {
      for (const { sql, params } of statements) {
        tx.exec({ sql, bind: (params ?? []) as any });
      }
    });
    if (cryptoKey) flushScheduler.markDirty();
    reply(correlationId, null);
  } catch (err) {
    replyError(correlationId, err);
  }
}

function handleQuery(sql: string, params: unknown[] | undefined, correlationId: string) {
  try {
    if (!db) throw new Error('Database not open');
    const rows: Record<string, unknown>[] = [];
    db.exec({
      sql,
      bind: (params ?? []) as any,
      rowMode: 'object',
      callback: (row: Record<string, unknown>) => { rows.push(row); },
    });
    reply(correlationId, rows);
  } catch (err) {
    replyError(correlationId, err);
  }
}

function handleQueryMulti(queries: Array<{ sql: string; params?: unknown[] }>, correlationId: string) {
  try {
    if (!db) throw new Error('Database not open');
    const results = queries.map(({ sql, params }) => {
      const rows: Record<string, unknown>[] = [];
      db!.exec({
        sql,
        bind: (params ?? []) as any,
        rowMode: 'object',
        callback: (row: Record<string, unknown>) => { rows.push(row); },
      });
      return rows;
    });
    reply(correlationId, results);
  } catch (err) {
    replyError(correlationId, err);
  }
}

async function handleFlush(correlationId: string) {
  try {
    await flushScheduler.flushNow();
    reply(correlationId, null);
  } catch (err) {
    replyError(correlationId, err);
  }
}

async function handleClose(correlationId: string) {
  try {
    await flushScheduler.flushNow();
    flushScheduler.reset();
    db?.close();
    db = null;
    cryptoKey = null;
    encryptedFileName = '';
    openDbName = '';
    releaseDbLock(lockRef);
    reply(correlationId, null);
  } catch (err) {
    replyError(correlationId, err);
  }
}

// ─── Message dispatch ─────────────────────────────────────────────────────────

self.addEventListener('message', ({ data }: MessageEvent<WorkerRequestWithCorrelationId>) => {
  const { type, correlationId } = data;
  switch (type) {
    case 'open':
      void handleOpen(data.dbName, data.statements, data.encryptionKey, correlationId);
      break;
    case 'exec':
      void handleExec(data.sql, data.params, correlationId);
      break;
    case 'exec-batch':
      void handleExecBatch(data.statements, correlationId);
      break;
    case 'query':
      handleQuery(data.sql, data.params, correlationId);
      break;
    case 'query-multi':
      handleQueryMulti(data.queries, correlationId);
      break;
    case 'close':
      void handleClose(correlationId);
      break;
    case 'flush':
      void handleFlush(correlationId);
      break;
    default:
      replyError((data as any).correlationId ?? '', `Unknown message type: ${(data as any).type}`);
  }
});
