import { fork, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { MXDBCollection } from '../../../src/common';
import { E2E_MONGO_DB_NAME, E2E_SERVER_PROCESS_ENV } from './mongoConstants';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_PROCESS_PATH = path.resolve(__dirname, './serverProcess.ts');
// tsconfig without source-level path aliases so tsx resolves @anupheaus/* to node_modules
// dists instead of the local source tree (which has a CJS→ESM cycle on Node 22).
const E2E_SERVER_TSCONFIG_PATH = path.resolve(__dirname, '../../../tsconfig.e2e-server.json');
/** "Power outage" delay between killing old server/mongod and booting their replacements. */
const SERVER_RESTART_WAIT_MS = 1000;

let memoryServer: MongoMemoryReplSet | null = null;
let persistentDbPath: string | null = null;
/** Pinned mongod port. Captured from the first boot; reused on every hard-kill restart
 *  so that the replset config stored in the preserved dbPath (which references this
 *  exact host:port) still points at a reachable mongod after restart. Without this,
 *  the library's "already initialized" handler in `_initReplSet` restores the old
 *  config via `replSetReconfig(force:true)` against a member URI that no longer exists,
 *  and `_waitForPrimary` hangs forever. */
let persistentMongoPort: number | null = null;
let currentPort = 0;
let serverChild: ChildProcess | null = null;

type ServerLogCallback = (stream: 'stdout' | 'stderr', line: string) => void;
let serverLogCallback: ServerLogCallback | null = null;

/**
 * Resolve `process.execPath` through any OS-level symlinks or junctions so
 * that `fork()` receives the real filesystem path.
 *
 * On Windows with nvm, `process.execPath` is often a junction path like
 * `C:\Program Files\nodejs\node.exe`. Windows `CreateProcess` (used by
 * Node's `spawn`/`fork` internally) can fail with ENOENT when the path goes
 * through a directory junction, even though the path resolves correctly via
 * other APIs. `realpathSync` follows the junction to the versioned binary,
 * e.g. `C:\Users\...\nvm\v22.14.0\node.exe`, which always works.
 */
function resolveNodeExecPath(): string {
  try {
    return fs.realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

function lifecycleLog(event: string, detail?: Record<string, unknown>) {
  if (!serverLogCallback) return;
  serverLogCallback('stdout', JSON.stringify({ type: 'lifecycle', event, detail, ts: new Date().toISOString() }));
}

export function setServerLogCallback(callback: ServerLogCallback | null) {
  serverLogCallback = callback;
}

export interface ServerInstance {
  port: number;
  stop(): Promise<void>;
}

/**
 * Start MongoDB Memory Server (replica set) and return its URI.
 * Change streams require a replica set, so we use MongoMemoryReplSet.
 *
 * Uses `wiredTiger` with a stable on-disk `dbPath` so that a hard SIGKILL of the
 * mongod process does not lose committed writes — on restart, mongod replays its
 * journal against the existing dbPath and resumes as if it had been cleanly stopped.
 * Any transactions that were in-flight at kill time are rolled back by wiredTiger
 * recovery; the sync engine is expected to detect the missing records via its
 * C2S retry queue and re-persist them.
 */
export async function startMongo(): Promise<{ getUri: () => string; stop: () => Promise<void> }> {
  if (memoryServer == null) {
    if (persistentDbPath == null) {
      persistentDbPath = path.join(os.tmpdir(), `mxdb-stress-mongo-${Date.now()}-${process.pid}`);
      fs.mkdirSync(persistentDbPath, { recursive: true });
      lifecycleLog('startMongo.dbPath.created', { dbPath: persistentDbPath });
    } else {
      lifecycleLog('startMongo.dbPath.reuse', { dbPath: persistentDbPath, pinnedPort: persistentMongoPort });
    }
    memoryServer = await MongoMemoryReplSet.create({
      replSet: {
        count: 1,
        storageEngine: 'wiredTiger',
        // Cap the mongod's transaction lifetime to 4s (vs the 60s default).
        // After a hard-kill restart, any doc locks held by in-flight txns at the
        // moment the old mongod died will be released within 4s when the new
        // mongod sees the journal rollback. Without this cap, the next server
        // child would stall for up to 60s on every affected document.
        args: ['--setParameter', 'transactionLifetimeLimitSeconds=4'],
      },
      instanceOpts: [{
        dbPath: persistentDbPath,
        storageEngine: 'wiredTiger',
        // Pin the port on restart (null on first boot — library picks one, we capture).
        ...(persistentMongoPort != null ? { port: persistentMongoPort } : {}),
        // After a hard-kill restart the wiredTiger journal replay can take longer
        // than the default 10 s, especially under stress-test load. 60 s gives
        // ample headroom without masking genuine "mongod never started" failures.
        launchTimeout: 60_000,
      }],
    });
    // Capture the port on first boot so subsequent hard-kill restarts can pin it.
    if (persistentMongoPort == null) {
      const port = (memoryServer.servers[0] as any)?._instanceInfo?.port
        ?? (memoryServer.servers[0] as any)?.instanceInfo?.port;
      if (typeof port === 'number' && port > 0) {
        persistentMongoPort = port;
        lifecycleLog('startMongo.port.captured', { port });
      } else {
        lifecycleLog('startMongo.port.captureFailed', { reason: 'no port on instanceInfo' });
      }
    }
  }
  return {
    getUri: () => memoryServer!.getUri(),
    stop: async () => {
      if (memoryServer != null) {
        await memoryServer.stop({ doCleanup: true });
        memoryServer = null;
      }
      if (persistentDbPath != null) {
        try { fs.rmSync(persistentDbPath, { recursive: true, force: true }); }
        catch (error) { lifecycleLog('startMongo.dbPath.cleanup.error', { error: String((error as any)?.message ?? error) }); }
        persistentDbPath = null;
      }
      persistentMongoPort = null;
    },
  };
}

/**
 * Hard-kill the mongod process (and its watchdog killer process) without any graceful
 * shutdown. This simulates pulling the power on the database host: wiredTiger's journal
 * will be replayed on the next mongod start, committed writes survive, uncommitted
 * in-flight transactions are lost.
 *
 * Resets `memoryServer` to `null` so the next `startMongo()` creates a fresh
 * `MongoMemoryReplSet` pointing at the preserved `persistentDbPath`. The library's
 * `_initReplSet` catches the "already initialized" error and applies the existing
 * replset config via `replSetReconfig`, so the restart Just Works.
 */
function hardKillMongo() {
  if (memoryServer == null) return;
  for (const server of memoryServer.servers) {
    const inst = (server as any)._instanceInfo?.instance;
    // Kill the watchdog FIRST — otherwise it would see the mongod exit and attempt
    // its own SIGTERM cleanup, which races against our SIGKILL and prints errors.
    const killer: ChildProcess | undefined = inst?.killerProcess;
    if (killer && !killer.killed) {
      try { killer.kill('SIGKILL'); }
      catch (error) { lifecycleLog('hardKillMongo.killer.error', { error: String((error as any)?.message ?? error) }); }
    }
    const mongod: ChildProcess | undefined = inst?.mongodProcess;
    if (mongod && !mongod.killed) {
      try { mongod.kill('SIGKILL'); }
      catch (error) { lifecycleLog('hardKillMongo.mongod.error', { error: String((error as any)?.message ?? error) }); }
    }
  }
  memoryServer = null;
}

/**
 * Start the MXDB sync server (HTTP + socket) on the given port. Uses existing Mongo Memory Server.
 */
export async function startServerInstance(
  port: number,
  mongoUri: string,
  _collectionsList: MXDBCollection[],
): Promise<ServerInstance> {
  if (serverChild != null) throw new Error('Server child already running');

  lifecycleLog('startServerInstance.spawn', { requestedPort: port });
  const child = fork(SERVER_PROCESS_PATH, {
    execPath: resolveNodeExecPath(),
    execArgv: ['--import', 'tsx/esm', '--no-warnings'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      [E2E_SERVER_PROCESS_ENV.PORT]: String(port),
      [E2E_SERVER_PROCESS_ENV.MONGO_URI]: mongoUri,
      [E2E_SERVER_PROCESS_ENV.MONGO_DB_NAME]: E2E_MONGO_DB_NAME,
      TSX_TSCONFIG_PATH: E2E_SERVER_TSCONFIG_PATH,
    },
  });
  serverChild = child;
  lifecycleLog('startServerInstance.spawned', { pid: child.pid });

  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (!serverLogCallback) return;
      String(chunk)
        .split(/\r?\n/u)
        .filter(line => line.length > 0)
        .forEach(line => serverLogCallback?.('stdout', line));
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      // Always forward to process.stderr so crash output appears in CI logs.
      process.stderr.write(`[e2e-server] ${String(chunk)}`);
      if (!serverLogCallback) return;
      String(chunk)
        .split(/\r?\n/u)
        .filter(line => line.length > 0)
        .forEach(line => serverLogCallback?.('stderr', line));
    });
  }

  const actualPort = await new Promise<number>((resolve, reject) => {
    lifecycleLog('startServerInstance.waitReady.start', { timeoutMs: 20_000 });
    const timeout = setTimeout(() => {
      lifecycleLog('startServerInstance.waitReady.timeout', { timeoutMs: 20_000 });
      reject(new Error('Timed out waiting for server child ready'));
    }, 20_000);
    child.on('message', (msg: any) => {
      if (msg && msg.type === 'ready') {
        clearTimeout(timeout);
        lifecycleLog('startServerInstance.waitReady.ready', { port: msg.port });
        resolve(Number(msg.port));
        return;
      }
      if (msg && msg.type === 'server-log' && serverLogCallback) {
        // Forward structured server log message to the test run logger.
        // We serialise the payload so the logger API stays (stream, line).
        const line = JSON.stringify(msg);
        serverLogCallback('stdout', line);
      }
    });
    child.on('exit', code => {
      clearTimeout(timeout);
      lifecycleLog('startServerInstance.exitEarly', { code });
      reject(new Error(`Server child exited early (code ${code})`));
    });
    child.on('error', err => {
      clearTimeout(timeout);
      lifecycleLog('startServerInstance.error', { message: String((err as any)?.message ?? err) });
      reject(err);
    });
  });

  currentPort = actualPort;
  lifecycleLog('startServerInstance.ready', { actualPort });

  return {
    get port() {
      return currentPort;
    },
    async stop() {
      if (serverChild != null) {
        const proc = serverChild;
        serverChild = null;
        lifecycleLog('stopServerInstance.begin', { pid: proc.pid });
        await new Promise<void>((resolve, reject) => {
          const forceMs = 15_000;
          const t = setTimeout(() => {
            // Last-resort hard kill if graceful shutdown didn't complete in time.
            try { proc.kill('SIGKILL'); } catch { /* ignore */ }
            reject(new Error(`Server child pid ${proc.pid} did not exit within ${forceMs}ms`));
          }, forceMs);
          proc.once('exit', (code, signal) => {
            clearTimeout(t);
            lifecycleLog('stopServerInstance.exited', { code, signal });
            resolve();
          });
          // IPC-based graceful shutdown — on Windows, proc.kill('SIGTERM') maps
          // to TerminateProcess which is instant and uncatchable, so we CANNOT
          // send a signal at all (it would kill the child before it can close its
          // MongoClient). Without a clean close, Mongo leaves in-flight transactions
          // holding document locks until transactionLifetimeLimitSeconds (60s),
          // which blocks the next server for ~60s on every affected document.
          // The child listens for { type: 'shutdown' } via IPC and exits itself.
          // The forceMs timeout above will SIGKILL if the child fails to exit.
          try { proc.send({ type: 'shutdown' }); }
          catch { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }
        });
        lifecycleLog('stopServerInstance.done');
      }
    },
  };
}

export interface LifecycleState {
  mongoUri: string;
  port: number;
  stopServer(): Promise<void>;
  restartServer(): Promise<ServerInstance>;
}

/**
 * Start Mongo (if not already) and the HTTP/socket server. Returns state with restart capability.
 *
 * `restartServer()` performs a **hard-kill power-outage simulation**: both the server
 * child process and the mongod process are SIGKILLed directly (no graceful shutdown,
 * no IPC, no session abort). After a brief "power outage" delay, a fresh mongod is
 * started against the same wiredTiger dbPath (committed writes survive), and a fresh
 * server child is started against the restored Mongo URI. The sync engine is expected
 * to detect any in-flight writes it never acked and re-persist them via its C2S retry
 * queue on client reconnect.
 *
 * `stopServer()` and `stopLifecycle()` still use the graceful IPC shutdown path so
 * end-of-test teardown remains clean.
 */
export async function startLifecycle(
  port: number,
  collectionsList: MXDBCollection[],
): Promise<LifecycleState> {
  lifecycleLog('startLifecycle.begin', { port });
  let mongo = await startMongo();
  let mongoUri = mongo.getUri();
  lifecycleLog('startLifecycle.mongoReady', { mongoUri });
  let instance = await startServerInstance(port, mongoUri, collectionsList);
  let portUsed = instance.port;
  lifecycleLog('startLifecycle.serverReady', { portUsed });

  async function stopServer() {
    lifecycleLog('lifecycle.stopServer.begin');
    await instance.stop();
    lifecycleLog('lifecycle.stopServer.done');
  }

  async function restartServer(): Promise<ServerInstance> {
    lifecycleLog('lifecycle.hardKill.begin');
    // 1) SIGKILL the server child directly — bypass IPC shutdown, bypass ServerDb.close(),
    //    no session aborts, no change-stream close, no mongo client drain. Pull the plug.
    if (serverChild != null) {
      const proc = serverChild;
      serverChild = null;
      const pid = proc.pid;
      lifecycleLog('lifecycle.hardKill.serverChild.sigkill', { pid });
      try { proc.kill('SIGKILL'); }
      catch (error) { lifecycleLog('lifecycle.hardKill.serverChild.error', { error: String((error as any)?.message ?? error) }); }
      // Wait for exit so the next startServerInstance doesn't race on the port.
      await new Promise<void>(resolve => {
        if (proc.exitCode != null || proc.signalCode != null) { resolve(); return; }
        const t = setTimeout(() => {
          lifecycleLog('lifecycle.hardKill.serverChild.exitTimeout', { pid });
          resolve();
        }, 2000);
        proc.once('exit', (code, signal) => {
          clearTimeout(t);
          lifecycleLog('lifecycle.hardKill.serverChild.exited', { pid, code, signal });
          resolve();
        });
      });
    }
    // 2) SIGKILL mongod (and its watchdog) directly — pull the plug on the database too.
    lifecycleLog('lifecycle.hardKill.mongo.sigkill');
    hardKillMongo();
    // 3) "Power outage" delay — nothing is running.
    await new Promise<void>(r => setTimeout(r, SERVER_RESTART_WAIT_MS));
    lifecycleLog('lifecycle.hardKill.powerOutDelay.done', { waitMs: SERVER_RESTART_WAIT_MS });
    // 4) "Power comes back on" — boot a fresh mongod against the preserved dbPath.
    //    wiredTiger journal recovery replays committed writes, rolls back in-flight txns.
    mongo = await startMongo();
    mongoUri = mongo.getUri();
    lifecycleLog('lifecycle.hardKill.mongoReady', { mongoUri });
    // 5) Boot a fresh server child pointing at the restored Mongo URI.
    instance = await startServerInstance(portUsed, mongoUri, collectionsList);
    portUsed = instance.port;
    lifecycleLog('lifecycle.hardKill.ready', { portUsed });
    return instance;
  }

  return {
    get mongoUri() { return mongoUri; },
    get port() { return portUsed; },
    stopServer,
    restartServer,
  } as LifecycleState;
}

/**
 * Stop the HTTP server and optionally the Mongo Memory Server. Call at end of test.
 */
export async function stopLifecycle(stopMongo = true): Promise<void> {
  if (serverChild != null) {
    const child = serverChild;
    serverChild = null;
    await new Promise<void>((resolve, reject) => {
      const forceMs = 15_000;
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        reject(new Error(`Server child did not exit within ${forceMs}ms`));
      }, forceMs);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try { child.send({ type: 'shutdown' }); }
      catch { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
    });
  }
  if (stopMongo && memoryServer != null) {
    // Only stop if actually running — calling startMongo() here would create a
    // new instance just to stop it (or hang retrying) if the server never started.
    const mongo = await startMongo();
    await mongo.stop();
  }
}
