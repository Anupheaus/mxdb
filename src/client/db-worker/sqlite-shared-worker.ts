/**
 * SQLite WASM SharedWorker — Multi-Tab Coordination
 *
 * One instance shared across all tabs of the same origin. Each tab connects
 * via a MessagePort and is assigned a unique portId on the first 'connect'
 * request. After any write (exec / exec-batch) a 'change-notification' is
 * broadcast to every other port so their DbCollections can reload.
 *
 * Encryption: when `encryptionKey` is supplied in the `open` request the
 * database is kept in memory and persisted as an AES-GCM blob (`*.enc`) in
 * OPFS after every write. All tabs share the same in-memory instance, so the
 * key only needs to be correct on the first open; subsequent tabs that trigger
 * a re-open will pass the same key (derived from the same WebAuthn credential).
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { ulid } from 'ulidx';
import type {
  WorkerRequest,
  WorkerResponse,
  ConnectRequest,
  DisconnectRequest,
} from './worker-messages';
import {
  isOpfsAvailable, flushEncrypted, openEncrypted, registerRegexp,
  acquireDbLock, releaseDbLock,
} from './sqlite-worker-shared';
import type { Sqlite3, OO1Db, LockRef } from './sqlite-worker-shared';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PortEntry {
  portId: string;
  port: MessagePort;
}

// ─── State ────────────────────────────────────────────────────────────────────

let db: OO1Db | null = null;
let sqlite3: Sqlite3 | null = null;
const ports = new Map<string, PortEntry>();

// Per-database encryption state
let cryptoKey: CryptoKey | null = null;
let encryptedFileName = '';
// Name of the database currently open. Used to make `open` idempotent: a second context
// opening the SAME database must not close+reopen the shared instance (which would briefly
// null `db` and make in-flight queries from other tabs throw "Database not open").
let openDbName = '';

// Exclusive Web Lock. Acquired once by the SharedWorker singleton on
// first open; skipped on subsequent opens because lockRef.release is already set.
// Prevents a second dedicated-worker tab from stealing the same OPFS file.
const lockRef: LockRef = { release: null };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function replyOn(port: MessagePort, correlationId: string, result: unknown) {
  const response: WorkerResponse = { correlationId, result };
  port.postMessage(response);
}

function replyErrorOn(port: MessagePort, correlationId: string, err: unknown) {
  const response: WorkerResponse = {
    correlationId,
    error: err instanceof Error ? err.message : String(err),
  };
  port.postMessage(response);
}

/** Broadcast a change notification to every connected port except the sender. */
function broadcastChange(senderPortId: string, collectionName: string) {
  for (const entry of ports.values()) {
    if (entry.portId === senderPortId) continue;
    entry.port.postMessage({ type: 'change-notification', collectionName });
  }
}

// ─── Operation handlers ───────────────────────────────────────────────────────

async function handleOpen(
  port: MessagePort,
  dbName: string,
  statements: string[],
  encryptionKey: Uint8Array | undefined,
  correlationId: string,
) {
  try {
    const acquired = await acquireDbLock(dbName, lockRef);
    if (!acquired) {
      replyErrorOn(port, correlationId, new Error(`Database "${dbName}" is already open in another context.`));
      return;
    }

    if (!sqlite3) {
      sqlite3 = await (sqlite3InitModule as any)({
        print: () => { /* suppress */ },
        printErr: () => { /* suppress */ },
      });
    }

    // Already open with the same database (another tab/context opened it through this shared
    // worker). Do NOT close and reopen — that briefly sets `db` to null, so any query already
    // in flight from another tab throws "Database not open". Just idempotently ensure the
    // requested tables exist (CREATE TABLE IF NOT EXISTS) and reply success.
    if (db && openDbName === dbName) {
      (db as any).transaction((tx: any) => {
        for (const sql of statements) tx.exec(sql);
      });
      replyOn(port, correlationId, null);
      return;
    }

    // A different database was open (e.g. user switched) — close it before opening the new one.
    if (db) {
      if (cryptoKey) await flushEncrypted(sqlite3!, db, cryptoKey, encryptedFileName);
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

    if (cryptoKey && sqlite3) await flushEncrypted(sqlite3, db!, cryptoKey, encryptedFileName);

    openDbName = dbName;
    replyOn(port, correlationId, null);
  } catch (err) {
    replyErrorOn(port, correlationId, err);
  }
}

async function handleExec(
  port: MessagePort,
  senderPortId: string,
  sql: string,
  params: unknown[] | undefined,
  correlationId: string,
  collectionHint: string | undefined,
) {
  try {
    if (!db || !sqlite3) throw new Error('Database not open');
    db.exec({ sql, bind: (params ?? []) as any });
    if (cryptoKey) await flushEncrypted(sqlite3, db, cryptoKey, encryptedFileName);
    replyOn(port, correlationId, null);
    if (collectionHint) broadcastChange(senderPortId, collectionHint);
  } catch (err) {
    replyErrorOn(port, correlationId, err);
  }
}

async function handleExecBatch(
  port: MessagePort,
  senderPortId: string,
  statements: Array<{ sql: string; params?: unknown[] }>,
  correlationId: string,
  collectionHint: string | undefined,
) {
  try {
    if (!db || !sqlite3) throw new Error('Database not open');
    (db as any).transaction((tx: any) => {
      for (const { sql, params } of statements) {
        tx.exec({ sql, bind: (params ?? []) as any });
      }
    });
    if (cryptoKey) await flushEncrypted(sqlite3, db, cryptoKey, encryptedFileName);
    replyOn(port, correlationId, null);
    if (collectionHint) broadcastChange(senderPortId, collectionHint);
  } catch (err) {
    replyErrorOn(port, correlationId, err);
  }
}

function handleQuery(
  port: MessagePort,
  sql: string,
  params: unknown[] | undefined,
  correlationId: string,
) {
  try {
    if (!db) throw new Error('Database not open');
    const rows: Record<string, unknown>[] = [];
    db.exec({
      sql,
      bind: (params ?? []) as any,
      rowMode: 'object',
      callback: (row: Record<string, unknown>) => { rows.push(row); },
    });
    replyOn(port, correlationId, rows);
  } catch (err) {
    replyErrorOn(port, correlationId, err);
  }
}

function handleQueryMulti(
  port: MessagePort,
  queries: Array<{ sql: string; params?: unknown[] }>,
  correlationId: string,
) {
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
    replyOn(port, correlationId, results);
  } catch (err) {
    replyErrorOn(port, correlationId, err);
  }
}

async function handleClose(port: MessagePort, correlationId: string) {
  try {
    if (db && sqlite3 && cryptoKey) await flushEncrypted(sqlite3, db, cryptoKey, encryptedFileName);
    db?.close();
    db = null;
    cryptoKey = null;
    encryptedFileName = '';
    openDbName = '';
    releaseDbLock(lockRef);
    replyOn(port, correlationId, null);
  } catch (err) {
    replyErrorOn(port, correlationId, err);
  }
}

function handleConnect(port: MessagePort, req: ConnectRequest) {
  const portId = ulid();
  ports.set(portId, { portId, port });
  replyOn(port, req.correlationId, portId);
}

function handleDisconnect(req: DisconnectRequest) {
  ports.delete(req.portId);
}

// ─── Per-port message dispatch ────────────────────────────────────────────────

function dispatchMessage(port: MessagePort, senderPortId: string, data: WorkerRequest) {
  switch (data.type) {
    case 'connect':
      handleConnect(port, data);
      break;
    case 'disconnect':
      handleDisconnect(data);
      break;
    case 'open':
      void handleOpen(port, data.dbName, data.statements, data.encryptionKey, data.correlationId);
      break;
    case 'exec':
      void handleExec(port, senderPortId, data.sql, data.params, data.correlationId, data.collectionHint);
      break;
    case 'exec-batch':
      void handleExecBatch(port, senderPortId, data.statements, data.correlationId, data.collectionHint);
      break;
    case 'query':
      handleQuery(port, data.sql, data.params, data.correlationId);
      break;
    case 'query-multi':
      handleQueryMulti(port, data.queries, data.correlationId);
      break;
    case 'close':
      void handleClose(port, data.correlationId);
      break;
    default:
      replyErrorOn(port, (data as any).correlationId ?? '', `Unknown message type: ${(data as any).type}`);
  }
}

// ─── SharedWorker entry point ─────────────────────────────────────────────────

(self as unknown as SharedWorkerGlobalScope).onconnect = (event: MessageEvent) => {
  const port: MessagePort = event.ports[0]!;
  port.start();

  let senderPortId = '';

  port.addEventListener('message', ({ data }: MessageEvent<WorkerRequest>) => {
    if (data.type === 'connect') {
      const portId = ulid();
      senderPortId = portId;
      ports.set(portId, { portId, port });
      replyOn(port, data.correlationId, portId);
      return;
    }
    if (data.type === 'disconnect') {
      handleDisconnect(data);
      return;
    }
    dispatchMessage(port, senderPortId, data);
  });
};
