/**
 * Makes every write to the encrypted in-memory database durable before the worker says it is done.
 *
 * The encrypted database lives in memory and is persisted as ONE encrypted snapshot (`<db>.enc`), coalesced to about a
 * second after the last write because it exports and encrypts the whole database (sc-680). Without more, a page
 * reloaded or closed inside that second lost the writes entirely: the worker is stopped with the page, and the flush
 * asked for on `pagehide` is an async export + encrypt + OPFS write that does not finish in time.
 *
 * So each write's statements are also appended, encrypted, to a write-ahead log in OPFS before the write is answered:
 * a small file per group of writes in `<db>.wal/`, costing about the size of the change rather than of the database
 * (1-3 ms in Chromium). The snapshot records the sequence number of the last write it holds, in `mxdb_wal_state`. On
 * open, the log entries after that number are replayed in order, exactly once; a snapshot that has been written prunes
 * the log files it covers.
 *
 * Writes that arrive while a log file is being written are grouped into the next one (group commit), so a burst of
 * writes costs a few files, not one each, and the files complete in sequence order.
 */
import { isOpfsAvailable } from './sqlite-worker-shared';
import type { OO1Db } from './sqlite-worker-shared';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Holds the sequence number of the last logged write the database contains. One row, id 1. */
const WAL_STATE_TABLE = 'mxdb_wal_state';
const WAL_STATE_DDL = `CREATE TABLE IF NOT EXISTS ${WAL_STATE_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL)`;
const IV_LENGTH = 12;
/** Log files are named by the last sequence number they hold, zero-padded so they also sort by name. */
const WAL_FILE_PATTERN = /^(\d{16})\.wal$/;
const WAL_FILE_DIGITS = 16;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WalStatement {
  sql: string;
  params?: unknown[];
}

/** One write (an exec or an exec-batch), as logged: replayed in one transaction. */
interface WalEntry {
  seq: number;
  statements: WalStatement[];
}

/** A parameter as JSON can carry it: a byte array is tagged, everything SQLite binds otherwise is plain JSON. */
type EncodedParam = unknown;

interface EncodedBytes {
  $bytes: string;
}

/** The subset of the OPFS directory API the log uses — `FileSystemDirectoryHandle` in a worker. */
export interface WalDirectory {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WalFileHandle>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterable<string>;
}

interface WalFileHandle {
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<WalWritable>;
}

interface WalWritable {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
  /** Discards what was written (the file keeps its previous contents). */
  abort?(): Promise<void>;
}

export interface OpenWriteAheadLogProps {
  db: OO1Db;
  cryptoKey: CryptoKey;
  /** The log's folder, or undefined where there is no OPFS (then writes are answered at once and nothing is logged). */
  directory: WalDirectory | undefined;
  /** Reports a problem the log recovered from (a file it could not write, read or replay). Never throws. */
  onProblem(message: string, meta: Record<string, unknown>): void;
}

export interface EncryptedWriteAheadLog {
  /**
   * Log a write that has just been applied to the database. Call it in the same synchronous step as the write, so the
   * sequence numbers follow the database's own order. Resolves once the write is in OPFS; it never rejects (a failure
   * is reported through `onProblem`, and the snapshot still covers the write about a second later).
   */
  append(statements: WalStatement[]): Promise<void>;
  /**
   * Persist a snapshot: records the last sequence number in the database, then calls `writeSnapshot`, which must
   * export the database before its first `await`. Once it reports the snapshot written, the log files it covers are
   * removed.
   */
  snapshot(writeSnapshot: () => Promise<boolean>): Promise<void>;
  /** How many logged writes {@link openWriteAheadLog} replayed into the database. */
  readonly replayedCount: number;
}

// ─── Encoding ─────────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isEncodedBytes(value: unknown): value is EncodedBytes {
  return value != null && typeof value === 'object' && typeof (value as EncodedBytes).$bytes === 'string';
}

function encodeParam(param: unknown): EncodedParam {
  if (param instanceof Uint8Array) return { $bytes: bytesToBase64(param) };
  // SQLite binds undefined as NULL; JSON would drop it from an object and turn it into null in an array anyway.
  if (param === undefined) return null;
  return param;
}

function decodeParam(param: EncodedParam): unknown {
  return isEncodedBytes(param) ? base64ToBytes(param.$bytes) : param;
}

function encodeEntries(entries: WalEntry[]): Uint8Array<ArrayBuffer> {
  const encoded = entries.map(({ seq, statements }) => ({
    seq,
    statements: statements.map(({ sql, params }) => ({ sql, params: params?.map(encodeParam) })),
  }));
  return new TextEncoder().encode(JSON.stringify(encoded));
}

function decodeEntries(bytes: Uint8Array): WalEntry[] {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as WalEntry[];
  return parsed.map(({ seq, statements }) => ({
    seq,
    statements: statements.map(({ sql, params }) => ({ sql, params: params?.map(decodeParam) })),
  }));
}

function walFileName(lastSeq: number): string {
  return `${String(lastSeq).padStart(WAL_FILE_DIGITS, '0')}.wal`;
}

/** The last sequence number a log file holds, from its name; undefined for anything else in the folder. */
function lastSeqOfFile(name: string): number | undefined {
  const match = WAL_FILE_PATTERN.exec(name);
  return match == null ? undefined : Number(match[1]);
}

// ─── Encryption ───────────────────────────────────────────────────────────────

async function encrypt(cryptoKey: CryptoKey, plain: Uint8Array<ArrayBuffer>): Promise<{ iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plain);
  return { iv, ciphertext };
}

async function decrypt(cryptoKey: CryptoKey, stored: ArrayBuffer): Promise<Uint8Array> {
  const iv = new Uint8Array(stored, 0, IV_LENGTH);
  const ciphertext = new Uint8Array(stored, IV_LENGTH);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext));
}

// ─── Database state ───────────────────────────────────────────────────────────

function readSnapshotSeq(db: OO1Db): number {
  db.exec(WAL_STATE_DDL);
  return Number(db.selectValue(`SELECT seq FROM ${WAL_STATE_TABLE} WHERE id = 1`) ?? 0);
}

function writeSnapshotSeq(db: OO1Db, seq: number): void {
  db.exec({ sql: `INSERT OR REPLACE INTO ${WAL_STATE_TABLE} (id, seq) VALUES (1, ?)`, bind: [seq] });
}

function applyEntry(db: OO1Db, { statements }: WalEntry): void {
  (db as unknown as { transaction(callback: (tx: OO1Db) => void): void }).transaction(tx => {
    for (const { sql, params } of statements) tx.exec({ sql, bind: (params ?? []) as never });
  });
}

// ─── Log folder ───────────────────────────────────────────────────────────────

async function listLogFiles(directory: WalDirectory): Promise<Array<{ name: string; lastSeq: number }>> {
  const files: Array<{ name: string; lastSeq: number }> = [];
  for await (const name of directory.keys()) {
    const lastSeq = lastSeqOfFile(name);
    if (lastSeq != null) files.push({ name, lastSeq });
  }
  return files.sort((left, right) => left.lastSeq - right.lastSeq);
}

async function readLogFile({ directory, cryptoKey, name }: { directory: WalDirectory; cryptoKey: CryptoKey; name: string }): Promise<WalEntry[]> {
  const handle = await directory.getFileHandle(name);
  const stored = await (await handle.getFile()).arrayBuffer();
  return decodeEntries(await decrypt(cryptoKey, stored));
}

async function writeLogFile({ directory, cryptoKey, entries }: { directory: WalDirectory; cryptoKey: CryptoKey; entries: WalEntry[] }): Promise<void> {
  const { iv, ciphertext } = await encrypt(cryptoKey, encodeEntries(entries));
  const handle = await directory.getFileHandle(walFileName(entries[entries.length - 1]!.seq), { create: true });
  // OPFS writes go to a swap file that replaces the file only on close: a page stopped mid-write leaves no partial file.
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(iv);
    await writable.write(ciphertext);
  } catch (error) {
    // Never close a half-written file: close() would commit it. Abort leaves no log file for this group.
    await writable.abort?.().catch(() => { /* the write already failed; that is what is reported */ });
    throw error;
  }
  await writable.close();
}

/** Replays every logged write after the snapshot, in order. Returns the last sequence number seen and how many ran. */
async function replay({ db, cryptoKey, directory, onProblem }: OpenWriteAheadLogProps): Promise<{ lastSeq: number; replayedCount: number }> {
  const snapshotSeq = readSnapshotSeq(db);
  if (directory == null) return { lastSeq: snapshotSeq, replayedCount: 0 };
  const files = await listLogFiles(directory);
  const entries: WalEntry[] = [];
  let lastSeq = snapshotSeq;
  for (const { name, lastSeq: fileLastSeq } of files) {
    lastSeq = Math.max(lastSeq, fileLastSeq);
    if (fileLastSeq <= snapshotSeq) continue; // already in the snapshot; pruned after the next one
    try {
      entries.push(...await readLogFile({ directory, cryptoKey, name }));
    } catch (error) {
      onProblem('A write-ahead log file could not be read; its writes are skipped', { name, error: describeError(error) });
    }
  }
  const toReplay = entries.filter(({ seq }) => seq > snapshotSeq).sort((left, right) => left.seq - right.seq);
  let replayedCount = 0;
  for (const entry of toReplay) {
    try {
      applyEntry(db, entry);
      replayedCount++;
    } catch (error) {
      // Each write is all-or-nothing; the rest are still replayed, as each rewrites whole records.
      onProblem('A logged write could not be replayed; it is skipped', { seq: entry.seq, error: describeError(error) });
    }
  }
  return { lastSeq, replayedCount };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Opens the log for a database just loaded from its snapshot: replays the writes the snapshot does not hold. */
export async function openWriteAheadLog(props: OpenWriteAheadLogProps): Promise<EncryptedWriteAheadLog> {
  const { db, cryptoKey, directory, onProblem } = props;
  const replayed = await replay(props);
  let lastSeq = replayed.lastSeq;
  let queue: Array<{ entry: WalEntry; done(): void }> = [];
  let isWriting = false;

  async function writeQueued(): Promise<void> {
    isWriting = true;
    while (queue.length > 0) {
      const group = queue;
      queue = [];
      try {
        await writeLogFile({ directory: directory!, cryptoKey, entries: group.map(({ entry }) => entry) });
      } catch (error) {
        onProblem('A write could not be added to the write-ahead log; the next snapshot holds it', {
          seqs: group.map(({ entry }) => entry.seq), error: describeError(error),
        });
      }
      group.forEach(({ done }) => done());
    }
    isWriting = false;
  }

  function append(statements: WalStatement[]): Promise<void> {
    const seq = ++lastSeq;
    if (directory == null) return Promise.resolve();
    return new Promise<void>(resolve => {
      queue.push({ entry: { seq, statements }, done: resolve });
      if (!isWriting) void writeQueued();
    });
  }

  async function prune(throughSeq: number): Promise<void> {
    if (directory == null) return;
    try {
      for (const { name, lastSeq: fileLastSeq } of await listLogFiles(directory)) {
        if (fileLastSeq <= throughSeq) await directory.removeEntry(name);
      }
    } catch (error) {
      // Harmless: a file the snapshot covers is skipped on replay, and the next snapshot prunes it.
      onProblem('Write-ahead log files covered by the snapshot could not be removed', { throughSeq, error: describeError(error) });
    }
  }

  async function snapshot(writeSnapshot: () => Promise<boolean>): Promise<void> {
    const throughSeq = lastSeq;
    writeSnapshotSeq(db, throughSeq);
    const isWritten = await writeSnapshot();
    if (isWritten) await prune(throughSeq);
  }

  return { append, snapshot, replayedCount: replayed.replayedCount };
}

/** The log folder for a database in OPFS, created if needed; undefined where there is no OPFS. */
export async function getWriteAheadLogDirectory(dbName: string): Promise<WalDirectory | undefined> {
  if (!isOpfsAvailable()) return undefined;
  const root = await navigator.storage.getDirectory();
  // FileSystemDirectoryHandle's async iteration (keys) is missing from older DOM typings.
  return await root.getDirectoryHandle(`${dbName}.wal`, { create: true }) as unknown as WalDirectory;
}
