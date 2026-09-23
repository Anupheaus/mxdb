import * as fs from 'fs';
import * as path from 'path';
import { condenseAppLoggerDetail, type AppLoggerRunLogDetail } from './appLoggerRunLogBridge';
import { condenseServerLogDetail } from './formatServerLogDetail';
import type { RunLogDetail, RunLogEvent, RunLogger } from './types';

// ---------------------------------------------------------------------------
// Active logger (set during setupE2E for Vitest mock + client forwarding)
// ---------------------------------------------------------------------------

let currentRunLogger: RunLogger | undefined;

/** Set from {@link setupE2E} so the mocked `Logger` and client harness can append lines. */
export function setE2eRunLogger(logger: RunLogger | undefined): void {
  currentRunLogger = logger;
}

export function getE2eRunLogger(): RunLogger | undefined {
  return currentRunLogger;
}

// ---------------------------------------------------------------------------
// Built-in loggers
// ---------------------------------------------------------------------------

/** Minimal logger for custom harnesses that do not use the file run log. */
export const e2eNoopRunLogger = {
  log(_event: RunLogEvent, _detail?: RunLogDetail): void {
    /* noop */
  },
};

/** Forwards to the active run log from {@link setupE2E}. */
export const e2eForwardingRunLogger = {
  log(event: RunLogEvent, detail?: RunLogDetail): void {
    getE2eRunLogger()?.log(event, detail);
  },
};

// ---------------------------------------------------------------------------
// File-backed logger
// ---------------------------------------------------------------------------

const DEFAULT_LOGS_DIR = path.join(__dirname, '..', 'logs');
const DEFAULT_PREFIX = 'e2e';
const DEFAULT_KEEP = 10;

export interface CreateRunLoggerOptions {
  /** Directory for log files. Defaults to `tests/e2e/logs/`. */
  logsDir?: string;
  /** Filename prefix (e.g. `'e2e'` → `e2e-2026-03-28T…-.log`). Defaults to `'e2e'`. */
  prefix?: string;
  /** Number of old log files (matching prefix) to keep. Defaults to `10`. Set to `0` to skip pruning. */
  keep?: number;
}

function pruneOldLogs(logsDir: string, prefix: string, keep: number): void {
  if (keep <= 0 || !fs.existsSync(logsDir)) return;
  const files = fs.readdirSync(logsDir)
    .filter(f => f.startsWith(`${prefix}-`) && f.endsWith('.log'))
    .sort();
  const toRemove = files.slice(0, -keep);
  for (const file of toRemove) {
    try {
      fs.unlinkSync(path.join(logsDir, file));
    } catch (err) {
      // Best-effort housekeeping: parallel test workers may already have deleted this file (ENOENT) or,
      // on Windows, be deleting/holding it at the same moment (EPERM/EBUSY). Never fail a suite over it.
      const { code } = err as NodeJS.ErrnoException;
      if (code !== 'ENOENT' && code !== 'EPERM' && code !== 'EBUSY') throw err;
    }
  }
}

export function createRunLogger(options?: CreateRunLoggerOptions): RunLogger {
  const logsDir = options?.logsDir ?? DEFAULT_LOGS_DIR;
  const prefix = options?.prefix ?? DEFAULT_PREFIX;
  const keep = options?.keep ?? DEFAULT_KEEP;

  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  pruneOldLogs(logsDir, prefix, keep);

  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${prefix}-${iso}.log`;
  const filepath = path.join(logsDir, filename);
  const stream = fs.createWriteStream(filepath, { flags: 'a' });

  function log(event: RunLogEvent, detail?: RunLogDetail): void {
    const tsNano = process.hrtime.bigint();
    const tsIso = new Date().toISOString();
    if (event === 'server_log' && detail != null) {
      const condensed = condenseServerLogDetail(detail);
      stream.write(`${tsNano}\t${tsIso}\t${event}\t${condensed}\n`);
      return;
    }
    if (event === 'app_logger' && detail != null) {
      const condensed = condenseAppLoggerDetail(detail as AppLoggerRunLogDetail);
      stream.write(`${tsNano}\t${tsIso}\t${event}\t${condensed}\n`);
      return;
    }
    stream.write(`${tsNano}\t${tsIso}\t${event}\t${JSON.stringify(detail ?? {})}\n`);
  }

  function close(): void {
    stream.end();
  }

  return { log, close };
}
