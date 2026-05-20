// Child process entrypoint: starts the MXDB sync server over HTTPS on a given port.
// Runs in its own process so we can "restart" by killing and respawning without
// hitting socket-api global handler registration conflicts.

require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const https = require('https');
const fs = require('fs');
const path = require('path');

const { Logger } = require('@anupheaus/common');
const { startServer } = require('../../../src/server');
const { e2eTestCollection } = require('./types');
const {
  E2E_MONGO_DB_NAME,
  E2E_SERVER_PROCESS_ENV,
  E2E_SOCKET_API_NAME,
} = require('./mongoConstants');

const PORT = Number(process.env[E2E_SERVER_PROCESS_ENV.PORT] || '0');
const MONGO_URI = process.env[E2E_SERVER_PROCESS_ENV.MONGO_URI];
const MONGO_DB_NAME = process.env[E2E_SERVER_PROCESS_ENV.MONGO_DB_NAME] || E2E_MONGO_DB_NAME;

if (!MONGO_URI) {
  // eslint-disable-next-line no-console
  console.error(`Missing env ${E2E_SERVER_PROCESS_ENV.MONGO_URI}`);
  process.exit(1);
}

// Force all Logger instances in this process to log at silly level (0) regardless of env vars,
// then forward every entry to the test worker via IPC so they appear in the e2e run log file.
Object.defineProperty(Logger.prototype, 'getMinLevel', {
  value: () => 0,
  writable: true,
  configurable: true,
});

Logger.registerListener({
  maxEntries: 1,
  onTrigger(entries) {
    if (typeof process.send !== 'function') return;
    for (const entry of entries) {
      const { getLevelAsString } = require('@anupheaus/common').Logger;
      process.send({
        type: 'server-log',
        logger: entry.names.join(' > '),
        level: getLevelAsString(entry.level),
        tsNano: process.hrtime.bigint().toString(),
        tsIso: entry.timestamp.toISO(),
        message: entry.message,
        args: entry.meta != null ? [entry.meta] : [],
      });
    }
  },
});

const logger = new Logger('mxdb-e2e-server');

const bootStartMs = Date.now();
function bootLog(phase, detail) {
  const elapsedMs = Date.now() - bootStartMs;
  logger.info(`[boot] ${phase} (+${elapsedMs}ms)`, detail ?? {});
}

bootLog('process.entry', { pid: process.pid, port: PORT, mongoDbName: MONGO_DB_NAME });

async function main() {
  bootLog('main.begin');
  const keyPath = path.join(__dirname, 'certs', 'localhost.key');
  const certPath = path.join(__dirname, 'certs', 'localhost.crt');
  bootLog('tls.readFiles.begin', { keyPath, certPath });
  const server = https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  });
  bootLog('tls.readFiles.done');

  bootLog('startServer.call');
  const serverInstance = await startServer({
    name: E2E_SOCKET_API_NAME,
    logger,
    collections: [e2eTestCollection],
    server,
    mongoDbName: MONGO_DB_NAME,
    mongoDbUrl: MONGO_URI,
    auth: { mode: 'webauthn' },
  });
  bootLog('startServer.returned');

  bootLog('server.listen.begin', { port: PORT });
  await new Promise((resolve, reject) => {
    server.listen(PORT, () => resolve());
    server.once('error', reject);
  });
  bootLog('server.listen.done');

  const addr = server.address();
  const actualPort = addr && typeof addr === 'object' ? addr.port : PORT;
  bootLog('ready.sending', { actualPort });
  if (process.send) process.send({ type: 'ready', port: actualPort });
  bootLog('ready.sent');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    bootLog('shutdown.signal');
    // Force-close socket-io/HTTP sockets so server.close() doesn't hang on long-lived connections.
    try {
      const io = server.sockets || null;
      if (io && typeof io.close === 'function') io.close();
    } catch { /* ignore */ }
    const httpClosed = new Promise(resolve => server.close(() => resolve()));
    // Cleanly close the MongoClient FIRST so in-flight transactions abort on the Mongo side.
    // Without this, Mongo leaves row locks held until transactionLifetimeLimitSeconds (60s),
    // causing the next-restarted server to stall for ~60s on every affected document.
    try {
      bootLog('shutdown.db.close.begin');
      await serverInstance.close();
      bootLog('shutdown.db.close.done');
    } catch (err) {
      bootLog('shutdown.db.close.error', { error: String((err && err.message) || err) });
    }
    // Give HTTP a brief grace period, then exit.
    await Promise.race([httpClosed, new Promise(r => setTimeout(r, 2000))]);
    bootLog('shutdown.closed');
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // IPC-based shutdown — Windows cannot invoke signal handlers via proc.kill('SIGTERM'),
  // so the test harness sends a { type: 'shutdown' } IPC message which we handle here.
  process.on('message', msg => {
    if (msg && msg.type === 'shutdown') shutdown();
  });
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err);
  bootLog('main.fatal', { error: String((err && err.message) || err), stack: err && err.stack });
  process.exit(1);
});

process.on('uncaughtException', err => {
  bootLog('uncaughtException', { error: String((err && err.message) || err), stack: err && err.stack });
  // eslint-disable-next-line no-console
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', err => {
  bootLog('unhandledRejection', { error: String((err && err.message) || err), stack: err && err.stack });
  // eslint-disable-next-line no-console
  console.error('[unhandledRejection]', err);
});
