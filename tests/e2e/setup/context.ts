import type { ServerAuditOf } from '../../../src/common';
import { dbs } from '../../../src/client/providers/dbs/Dbs';
import { formatServerLogDetail } from './formatServerLogDetail';
import { readServerAuditDocuments } from './readServerAudits';
import { readServerRecords } from './readServerRecords';
import {
  startLifecycle,
  setServerLogCallback,
  stopLifecycle,
  type LifecycleState,
} from './serverLifecycle';
import type { RunLogger } from './types';
import { createSyncClient, type SyncClient } from './syncClient';
import { e2eTestCollection, type E2eTestRecord } from './types';
import { installBrowserEnvironment } from './browserEnvironment';
import { clearE2eTestCollections } from './mongoData';
import { E2E_SERVER_PROCESS_ENV } from './mongoConstants';
import {
  createRunLogger,
  e2eForwardingRunLogger,
  setE2eRunLogger,
  type CreateRunLoggerOptions,
} from './runLogger';

export interface SetupE2EOptions {
  /** Passed to `startLifecycle` (`0` = OS-chosen port). */
  port?: number;
  /** If true, do not clear `e2eTest` / `e2eTest_sync` after the server is ready. */
  skipInitialMongoClear?: boolean;
  /** Override log file directory, prefix, or retention count for the run logger. */
  runLoggerOptions?: CreateRunLoggerOptions;
  /**
   * Absolute path of a module the forked server imports before starting (and on every restart), for a
   * suite's own server-only collection extensions. Kept next to the suite that needs it, not in setup.
   */
  serverExtensionsModule?: string;
}

/** Named client handle: same as {@link SyncClient} with optional host on `connect()`. */
export type E2EClientHandle = SyncClient & {
  /**
   * Mount the React tree and wait for the driver. If `host` is omitted, uses
   * `useServer().socketHost` (`localhost:${port}`).
   */
  connect(host?: string): Promise<void>;
};

export interface E2EServerAccess {
  readonly mongoUri: string;
  readonly port: number;
  /** Socket host without protocol (socket-api builds `wss://` from this). */
  readonly socketHost: string;
  stopServer(): Promise<void>;
  restartServer(): ReturnType<LifecycleState['restartServer']>;
  /** All rows in the server `e2eTest` collection. */
  readLiveRecords(): Promise<E2eTestRecord[]>;
  /** Parsed audit documents from `{liveCollectionName}_sync` (default `e2eTest`). */
  readAudits(liveCollectionName?: string): Promise<Map<string, ServerAuditOf<E2eTestRecord>>>;
  /** Same as initial reset: truncate default live + `_sync` audit collections. */
  clearStoredCollectionData(): Promise<void>;
  /**
   * Poll Mongo until `e2eTest` contains a row with the given id (or timeout).
   * Use after local upserts so C2S sync can finish.
   */
  waitForLiveRecord(
    recordId: string,
    options?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<void>;
}

interface ClientEntry {
  dbName: string;
  raw: SyncClient;
}

interface E2EContextInternal {
  lifecycle: LifecycleState;
  clients: Map<string, ClientEntry>;
  runLogger: RunLogger;
  /** Incremented for each `app_logger` line at error level (stress tests can assert zero). */
  appLoggerErrorStats: { count: number };
  processErrorHandlers: {
    onUnhandledRejection: (reason: unknown) => void;
    onUncaughtException: (error: Error) => void;
  };
}

let ctx: E2EContextInternal | null = null;

function clientDbName(label: string): string {
  return `e2e-client-${label}`;
}

function requireCtx(): E2EContextInternal {
  if (ctx == null) {
    throw new Error('E2E: call setupE2E() from beforeAll (or await setupE2E()) before useClient / useServer.');
  }
  return ctx;
}

function wrapClient(raw: SyncClient): E2EClientHandle {
  const origConnect = raw.connect.bind(raw);
  const hostConnect = (host?: string) => {
    const h = host ?? useServer().socketHost;
    return origConnect(h);
  };
  const handle = raw as E2EClientHandle;
  handle.connect = hostConnect;
  return handle;
}

/**
 * One-time environment (IndexedDB + JSDOM), MongoDB Memory Server, and HTTPS sync server child.
 * Temporarily clears `global.window` / `document` while spawning the server child.
 */
export async function setupE2E(options?: SetupE2EOptions): Promise<void> {
  if (ctx != null) {
    throw new Error('E2E: setupE2E() was already called. Call teardownE2E() in afterAll before starting another suite in the same worker.');
  }

  installBrowserEnvironment();

  const port = options?.port ?? 0;
  // The forked server inherits this worker's env (restarts included); teardownE2E removes it again.
  if (options?.serverExtensionsModule != null) process.env[E2E_SERVER_PROCESS_ENV.EXTENSIONS_MODULE] = options.serverExtensionsModule;
  const win = (globalThis as unknown as { window?: unknown }).window;
  const doc = (globalThis as unknown as { document?: Document }).document;
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { document?: Document }).document;

  const baseRunLogger = createRunLogger({ prefix: 'e2e', ...options?.runLoggerOptions });
  const appLoggerErrorStats = { count: 0 };
  const runLogger: RunLogger = {
    log(event, detail) {
      if (event === 'app_logger' && detail != null) {
        const lvl = String((detail as { level?: string }).level ?? '').toLowerCase();
        if (lvl === 'error') {
          // Socket transport errors (e.g. `Socket connection error: websocket error`) are
          // logged by socket-api's SocketProvider whenever a `connect_error` event fires.
          // During tests that intentionally restart the server mid-workload, every connected
          // client will see one such event per restart — the socket layer then reconnects
          // and operation continues normally. They're not correctness failures, so exclude
          // them from the stress-test error assertion.
          const msg = String((detail as { message?: string }).message ?? '');
          if (!/^Socket connection error:/i.test(msg)) {
            appLoggerErrorStats.count += 1;
          }
        }
      }
      baseRunLogger.log(event, detail);
    },
    close: () => baseRunLogger.close(),
  };
  setE2eRunLogger(runLogger);
  setServerLogCallback((stream, line) => {
    const detail = formatServerLogDetail(stream, line);
    if (detail != null) runLogger.log('server_log', detail);
  });

  runLogger.log('test_setup', { phase: 'e2e_setupE2E', port: options?.port ?? 0 });

  let lifecycle: LifecycleState;
  try {
    lifecycle = await startLifecycle(port, [e2eTestCollection]);
    if (!options?.skipInitialMongoClear) {
      await clearE2eTestCollections(lifecycle.mongoUri);
    }
  } finally {
    if (win !== undefined) {
      (globalThis as unknown as { window: unknown }).window = win;
    } else {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
    if (doc !== undefined) {
      (globalThis as unknown as { document: Document }).document = doc;
    } else {
      delete (globalThis as unknown as { document?: Document }).document;
    }
  }

  runLogger.log('server_start', { port: lifecycle.port });

  const onUnhandledRejection = (reason: unknown) => {
    const msg = String((reason as { message?: string })?.message ?? reason);
    // Socket.io's _clearAcks fires synchronous rejections for all pending
    // emitWithAck calls when the transport closes (e.g. mid-test server
    // SIGKILL). The CD already catches these in its try/catch, but the
    // socket.io library creates a second rejection on the same Error from
    // inside the close-event handler before the microtask queue runs the
    // caller's .then chain. These are harmless — the sync engine retries
    // on reconnect — so swallow them instead of letting Vitest report them.
    if (/socket has been disconnected|transport close/i.test(msg)) {
      runLogger.log('suppressed_rejection', { reason: msg });
      return;
    }
    runLogger.log('error', {
      type: 'unhandledRejection',
      reason: msg,
    });
  };
  const onUncaughtException = (error: Error) => {
    runLogger.log('error', {
      type: 'uncaughtException',
      error: String(error?.message ?? error),
      stack: String(error?.stack ?? ''),
    });
  };
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);
  const processErrorHandlers = { onUnhandledRejection, onUncaughtException };

  ctx = { lifecycle, clients: new Map(), runLogger, appLoggerErrorStats, processErrorHandlers };
}

/**
 * Disconnect local clients, close their DB handles, and clear server-side default collection data.
 * Intended for `beforeEach` so each test starts from an empty server and fresh client DB names
 * are recreated on next `useClient`.
 */
export async function resetE2E(): Promise<void> {
  const c = requireCtx();
  c.runLogger.log('test_setup', { phase: 'e2e_reset' });
  for (const { dbName, raw } of c.clients.values()) {
    raw.unmount();
    await dbs.close(dbName);
  }
  c.clients.clear();
  await clearE2eTestCollections(c.lifecycle.mongoUri);
}

/**
 * Stop clients, terminate the server child, and stop MongoDB Memory Server.
 * Safe to call when setup was skipped (no-op).
 */
export async function teardownE2E(): Promise<void> {
  if (ctx == null) return;
  delete process.env[E2E_SERVER_PROCESS_ENV.EXTENSIONS_MODULE];
  const { runLogger, processErrorHandlers } = ctx;
  for (const { dbName, raw } of ctx.clients.values()) {
    raw.unmount();
    await dbs.close(dbName);
  }
  process.off('unhandledRejection', processErrorHandlers.onUnhandledRejection);
  process.off('uncaughtException', processErrorHandlers.onUncaughtException);
  ctx.clients.clear();
  await stopLifecycle(true);
  runLogger.log('server_stop', {});
  runLogger.log('test_end', {});
  setServerLogCallback(null);
  setE2eRunLogger(undefined);
  runLogger.close();
  ctx = null;
}

/**
 * Access the running e2e server: Mongo URI, port, and helpers to read or clear data.
 */
export function useServer(): E2EServerAccess {
  const { lifecycle } = requireCtx();
  const socketHost = `localhost:${lifecycle.port}`;
  const mongoUri = lifecycle.mongoUri;
  return {
    mongoUri,
    port: lifecycle.port,
    socketHost,
    stopServer: () => lifecycle.stopServer(),
    restartServer: () => lifecycle.restartServer(),
    readLiveRecords: () => readServerRecords(mongoUri),
    readAudits: (liveCollectionName = e2eTestCollection.name) =>
      readServerAuditDocuments(mongoUri, liveCollectionName),
    clearStoredCollectionData: () => clearE2eTestCollections(mongoUri),
    waitForLiveRecord: async (recordId, options) => {
      const timeoutMs = options?.timeoutMs ?? 30_000;
      const intervalMs = options?.intervalMs ?? 50;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const rows = await readServerRecords(mongoUri);
        if (rows.some(r => r.id === recordId)) return;
        if (Date.now() >= deadline) {
          throw new Error(
            `E2E: waitForLiveRecord("${recordId}") timed out after ${timeoutMs}ms`,
          );
        }
        await new Promise<void>(r => setTimeout(r, intervalMs));
      }
    },
  };
}

/**
 * Access the run logger created by {@link setupE2E}. Use for custom test-level event logging.
 */
export function useRunLogger(): RunLogger {
  return requireCtx().runLogger;
}

/**
 * Count of `app_logger` run-log lines at error level since {@link setupE2E} (e.g. `Logger.error` from clients).
 * Use in stress / integration tests to fail when the app reported errors during the run.
 */
export function getAppLoggerErrorCount(): number {
  return requireCtx().appLoggerErrorStats.count;
}

/**
 * Return a named client, creating it on first use. Each label gets a stable logical name until
 * {@link resetE2E} or {@link teardownE2E}, which unmount and drop the client so the next
 * `useClient` builds a new one.
 */
export function useClient(label: string): E2EClientHandle {
  if (label.length === 0) throw new Error('useClient: label must be non-empty');
  const c = requireCtx();
  let entry = c.clients.get(label);
  if (entry == null) {
    const dbName = clientDbName(label);
    const encryptionKey = crypto.getRandomValues(new Uint8Array(32));
    const raw = createSyncClient(`e2e-${label}`, e2eForwardingRunLogger, { dbName, encryptionKey });
    entry = { dbName, raw };
    c.clients.set(label, entry);
  }
  return wrapClient(entry.raw);
}
