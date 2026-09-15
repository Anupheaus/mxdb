/**
 * Shared helpers used by both sqlite-worker.ts (dedicated Worker) and
 * sqlite-shared-worker.ts (SharedWorker). Contains all OPFS/encryption logic
 * and the Web Lock helpers. Neither worker entry point is referenced here.
 */

import type sqlite3InitModule from '@sqlite.org/sqlite-wasm';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
export type OO1Db = InstanceType<Sqlite3['oo1']['DB']>;

/** Mutable ref passed to acquireDbLock / releaseDbLock in place of a module-level variable. */
export interface LockRef {
  release: (() => void) | null;
}

// ─── OPFS helpers ─────────────────────────────────────────────────────────────

export function isOpfsAvailable(): boolean {
  try {
    return typeof (globalThis as any).navigator?.storage?.getDirectory === 'function';
  } catch {
    return false;
  }
}

/**
 * Reads, decrypts and deserialises an existing encrypted database from OPFS.
 * Returns the decrypted bytes, or `undefined` if the file doesn't exist yet.
 */
export async function readAndDecryptOpfs(key: CryptoKey, fileName: string): Promise<Uint8Array | undefined> {
  try {
    const root = await (navigator.storage as any).getDirectory();
    const fh = await root.getFileHandle(fileName, { create: false });
    const file = await fh.getFile();
    const buf = await file.arrayBuffer();
    if (buf.byteLength <= 12) return undefined; // too small to be valid
    const iv = new Uint8Array(buf, 0, 12);
    const ciphertext = new Uint8Array(buf, 12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new Uint8Array(plain);
  } catch {
    return undefined; // file not found or decryption failed → fresh DB
  }
}

/**
 * Serialises the in-memory DB, encrypts it with AES-GCM and writes it to OPFS.
 * Format: [12-byte IV][AES-GCM ciphertext].
 *
 * If createWritable fails with a swap-file error, attempts to rename any
 * orphaned .crswap file out of the way and retries once. On a second failure,
 * logs an error and returns without throwing so the caller's SQL result is
 * unaffected.
 */
export async function flushEncrypted(s3: Sqlite3, database: OO1Db, cryptoKey: CryptoKey, encryptedFileName: string): Promise<void> {
  if (!isOpfsAvailable()) return;
  const dbBytes: Uint8Array = (s3.capi as any).sqlite3_js_db_export(database.pointer, 'main');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const dbBuf: ArrayBuffer = dbBytes.buffer.slice(dbBytes.byteOffset, dbBytes.byteOffset + dbBytes.byteLength) as ArrayBuffer;
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, dbBuf);
  const out = new Uint8Array(12 + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), 12);
  const root = await (navigator.storage as any).getDirectory();
  const fh = await root.getFileHandle(encryptedFileName, { create: true });

  let writable: FileSystemWritableFileStream;
  try {
    writable = await (fh as any).createWritable({ keepExistingData: false });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('swap file')) throw err;
    // Orphaned swap file may be preventing createWritable — attempt cleanup and retry.
    const swapName = `${encryptedFileName}.crswap`;
    const backupSwapName = `${encryptedFileName}.crswap.old`;
    try {
      const swapHandle = await root.getFileHandle(swapName, { create: false });
      try { await root.removeEntry(backupSwapName); } catch { /* no prior backup, that's fine */ }
      await (swapHandle as any).move(backupSwapName);
      console.warn('[mxdb-worker] Orphaned OPFS swap file — renamed and retrying flush', { encryptedFileName, backupSwapName });
    } catch (cleanupErr) {
      console.error('[mxdb-worker] OPFS flush failed; swap cleanup also failed', { encryptedFileName, error: (cleanupErr as Error)?.message ?? String(cleanupErr) });
      return;
    }
    try {
      writable = await (fh as any).createWritable({ keepExistingData: false });
    } catch (retryErr) {
      console.error('[mxdb-worker] OPFS flush failed again after swap cleanup — giving up', { encryptedFileName, error: (retryErr as Error)?.message ?? String(retryErr) });
      return;
    }
  }

  try {
    await writable.write(out);
  } finally {
    await writable.close();
  }
}

/**
 * Opens an in-memory SQLite DB, loading and decrypting existing data from OPFS
 * when available.
 */
export async function openEncrypted(
  s3: Sqlite3,
  dbName: string,
  keyBytes: Uint8Array,
): Promise<{ db: OO1Db; cryptoKey: CryptoKey; encryptedFileName: string }> {
  const keyBuf: ArrayBuffer = keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey('raw', keyBuf, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const encryptedFileName = `${dbName}.enc`;

  const existingBytes = isOpfsAvailable()
    ? await readAndDecryptOpfs(cryptoKey, encryptedFileName)
    : undefined;

  const db = new s3.oo1.DB(':memory:', 'ct');

  if (existingBytes != null) {
    // Load the decrypted bytes into the in-memory DB via sqlite3_deserialize.
    // SQLITE_DESERIALIZE_FREEONCLOSE (1) — SQLite frees the buffer on close.
    // SQLITE_DESERIALIZE_RESIZEABLE (2) — buffer can grow for writes.
    const pData = (s3.wasm as any).allocFromTypedArray(existingBytes);
    const rc = (s3.capi as any).sqlite3_deserialize(
      db.pointer, 'main', pData,
      existingBytes.byteLength, existingBytes.byteLength,
      1 | 2, // FREEONCLOSE | RESIZEABLE
    );
    if (rc !== 0) {
      (s3.wasm as any).dealloc(pData);
      throw new Error(`sqlite3_deserialize failed with code ${rc}`);
    }
  }

  return { db, cryptoKey, encryptedFileName };
}

// ─── REGEXP custom function ───────────────────────────────────────────────────

export function registerRegexp(_s3: Sqlite3, database: OO1Db) {
  (database as any).createFunction('regexp', (_ctx: unknown, pattern: string, value: string) => {
    try {
      return new RegExp(pattern).test(value) ? 1 : 0;
    } catch {
      return 0;
    }
  }, { arity: 2 });
}

// ─── Web Lock helpers ─────────────────────────────────────────────────────────

/**
 * Acquires an exclusive Web Lock named `mxdb-db-${dbName}`.
 * Returns `true` if acquired (or if Locks API is unavailable / already held).
 * Returns `false` if another context already holds the lock.
 */
export function acquireDbLock(dbName: string, lockRef: LockRef): Promise<boolean> {
  if (lockRef.release != null || typeof navigator === 'undefined' || navigator.locks == null) {
    // [LOCK-DIAG] fast-true path — either this context already holds the lock, or the Locks API is unavailable.
    console.warn('[LOCK-DIAG] acquireDbLock fast-true', { t: Date.now(), dbName, alreadyHeldByThisContext: lockRef.release != null }); // [LOCK-DIAG]
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    navigator.locks.request(`mxdb-db-${dbName}`, { ifAvailable: true }, lock => {
      if (lock == null) {
        console.warn('[LOCK-DIAG] acquireDbLock UNAVAILABLE — held by another context (ifAvailable=false)', { t: Date.now(), dbName }); // [LOCK-DIAG]
        resolve(false); return Promise.resolve();
      }
      let release!: () => void;
      const held = new Promise<void>(r => { release = r; });
      lockRef.release = release;
      console.warn('[LOCK-DIAG] acquireDbLock ACQUIRED via navigator.locks', { t: Date.now(), dbName }); // [LOCK-DIAG]
      resolve(true);
      return held;
    });
  });
}

export function releaseDbLock(lockRef: LockRef): void {
  console.warn('[LOCK-DIAG] releaseDbLock', { t: Date.now(), wasHeld: lockRef.release != null }); // [LOCK-DIAG]
  lockRef.release?.();
  lockRef.release = null;
}
