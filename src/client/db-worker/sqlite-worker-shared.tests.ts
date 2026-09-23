/* eslint-disable max-classes-per-file -- fakes for the browser/driver classes this module talks to */
// Behavioural tests for the helpers shared by the dedicated and shared SQLite workers. The browser
// boundaries (OPFS via navigator.storage, Web Locks via navigator.locks) are replaced with in-memory
// fakes; SQLite itself is the real @sqlite.org/sqlite-wasm build and encryption is real WebCrypto.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LockRef, OO1Db, Sqlite3 } from './sqlite-worker-shared';
import {
  acquireDbLock,
  flushEncrypted,
  isOpfsAvailable,
  openEncrypted,
  readAndDecryptOpfs,
  registerRegexp,
  releaseDbLock,
} from './sqlite-worker-shared';

// ─── Fakes ────────────────────────────────────────────────────────────────────

const KEY_BYTES = new Uint8Array(32).fill(7);
const OTHER_KEY_BYTES = new Uint8Array(32).fill(9);
const DB_NAME = 'secure-db';
const ENCRYPTED_FILE = `${DB_NAME}.enc`;
const SWAP_FILE = `${ENCRYPTED_FILE}.crswap`;
const SWAP_BACKUP_FILE = `${ENCRYPTED_FILE}.crswap.old`;
const IV_LENGTH = 12;
const SWAP_FILE_ERROR = 'Failed to create swap file';

type CreateWritableBehaviour = () => void;

interface FakeWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** In-memory Origin Private File System directory with just the calls the worker helpers use. */
class FakeOpfsDirectory {
  files = new Map<string, Uint8Array>();
  /** Queue of behaviours run on successive createWritable calls (throw to simulate failure). */
  createWritableBehaviours: CreateWritableBehaviour[] = [];
  closedWritables = 0;

  async getFileHandle(name: string, { create }: { create: boolean }) {
    if (!this.files.has(name)) {
      if (!create) throw new DOMException(`File "${name}" not found`, 'NotFoundError');
      this.files.set(name, new Uint8Array());
    }
    return {
      getFile: async () => ({ arrayBuffer: async () => this.#toArrayBuffer(this.files.get(name)!) }),
      createWritable: async (): Promise<FakeWritable> => {
        this.createWritableBehaviours.shift()?.();
        return {
          write: async data => { this.files.set(name, new Uint8Array(data)); },
          close: async () => { this.closedWritables++; },
        };
      },
      move: async (newName: string) => {
        this.files.set(newName, this.files.get(name)!);
        this.files.delete(name);
      },
    };
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name)) throw new DOMException(`File "${name}" not found`, 'NotFoundError');
  }

  #toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}

function installOpfs(directory: FakeOpfsDirectory): void {
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => directory } });
}

async function loadSqlite(): Promise<Sqlite3> {
  const { default: init } = await import('@sqlite.org/sqlite-wasm');
  // The published typings declare no options, but the Emscripten module accepts print overrides.
  const initWithOptions = init as unknown as (options: object) => Promise<Sqlite3>;
  return initWithOptions({ print: () => { /* silence */ }, printErr: () => { /* silence */ } });
}

async function importKey(keyBytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(keyBytes: Uint8Array<ArrayBuffer>, plain: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(keyBytes), plain);
  const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_LENGTH);
  return out;
}

function selectNames(db: OO1Db): string[] {
  return db.selectValues('SELECT name FROM people ORDER BY name') as string[];
}

function swapFileError(): never {
  throw new Error(SWAP_FILE_ERROR);
}

let sqlite3: Sqlite3;

beforeEach(async () => {
  sqlite3 ??= await loadSqlite();
  vi.spyOn(console, 'warn').mockImplementation(() => { /* silence diagnostics */ });
  vi.spyOn(console, 'error').mockImplementation(() => { /* silence diagnostics */ });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── isOpfsAvailable ──────────────────────────────────────────────────────────

describe('isOpfsAvailable', () => {
  it('is true when navigator.storage.getDirectory is a function', () => {
    installOpfs(new FakeOpfsDirectory());

    expect(isOpfsAvailable()).toBe(true);
  });

  it.each([
    ['there is no navigator', undefined],
    ['navigator has no storage', {}],
    ['storage has no getDirectory', { storage: {} }],
    ['getDirectory is not a function', { storage: { getDirectory: 'nope' } }],
  ])('is false when %s', (_label, navigatorValue) => {
    vi.stubGlobal('navigator', navigatorValue);

    expect(isOpfsAvailable()).toBe(false);
  });

  it('is false when reading navigator.storage throws', () => {
    vi.stubGlobal('navigator', { get storage(): never { throw new Error('SecurityError'); } });

    expect(isOpfsAvailable()).toBe(false);
  });
});

// ─── readAndDecryptOpfs ───────────────────────────────────────────────────────

describe('readAndDecryptOpfs', () => {
  it('returns the decrypted bytes of a file encrypted with the same key', async () => {
    const directory = new FakeOpfsDirectory();
    directory.files.set(ENCRYPTED_FILE, await encrypt(KEY_BYTES, new Uint8Array([1, 2, 3, 4])));
    installOpfs(directory);

    const plain = await readAndDecryptOpfs(await importKey(KEY_BYTES), ENCRYPTED_FILE);

    expect(Array.from(plain ?? [])).toEqual([1, 2, 3, 4]);
  });

  it.each([
    ['the file does not exist', null],
    ['the file is empty', new Uint8Array()],
    ['the file is no longer than the IV', new Uint8Array(IV_LENGTH)],
  ])('returns undefined when %s', async (_label, contents) => {
    const directory = new FakeOpfsDirectory();
    if (contents != null) directory.files.set(ENCRYPTED_FILE, contents);
    installOpfs(directory);

    expect(await readAndDecryptOpfs(await importKey(KEY_BYTES), ENCRYPTED_FILE)).toBeUndefined();
  });

  it('returns undefined when the file was encrypted with a different key', async () => {
    const directory = new FakeOpfsDirectory();
    directory.files.set(ENCRYPTED_FILE, await encrypt(OTHER_KEY_BYTES, new Uint8Array([1, 2, 3])));
    installOpfs(directory);

    expect(await readAndDecryptOpfs(await importKey(KEY_BYTES), ENCRYPTED_FILE)).toBeUndefined();
  });

  it('returns undefined when the file contents have been tampered with', async () => {
    const directory = new FakeOpfsDirectory();
    const encrypted = await encrypt(KEY_BYTES, new Uint8Array([1, 2, 3]));
    encrypted.set([encrypted.at(-1)! ^ 0xff], encrypted.length - 1);
    directory.files.set(ENCRYPTED_FILE, encrypted);
    installOpfs(directory);

    expect(await readAndDecryptOpfs(await importKey(KEY_BYTES), ENCRYPTED_FILE)).toBeUndefined();
  });
});

// ─── openEncrypted / flushEncrypted ───────────────────────────────────────────

describe('openEncrypted and flushEncrypted', () => {
  async function writePeopleAndFlush(directory: FakeOpfsDirectory, names: string[]): Promise<void> {
    installOpfs(directory);
    const { db, cryptoKey, encryptedFileName } = await openEncrypted(sqlite3, DB_NAME, KEY_BYTES);
    db.exec('CREATE TABLE IF NOT EXISTS people (name TEXT)');
    for (const name of names) db.exec({ sql: 'INSERT INTO people(name) VALUES (?)', bind: [name] });
    await flushEncrypted(sqlite3, db, cryptoKey, encryptedFileName);
    db.close();
  }

  it('opens an empty database named after the database when nothing is stored yet', async () => {
    installOpfs(new FakeOpfsDirectory());

    const { db, encryptedFileName } = await openEncrypted(sqlite3, DB_NAME, KEY_BYTES);

    expect([encryptedFileName, db.selectValues('SELECT name FROM sqlite_master')]).toEqual([ENCRYPTED_FILE, []]);
  });

  it('opens an empty database when OPFS is unavailable', async () => {
    vi.stubGlobal('navigator', {});

    const { db } = await openEncrypted(sqlite3, DB_NAME, KEY_BYTES);

    expect(db.selectValues('SELECT name FROM sqlite_master')).toEqual([]);
  });

  it('restores the data from a previous flush when reopened with the same key', async () => {
    const directory = new FakeOpfsDirectory();
    await writePeopleAndFlush(directory, ['Alice', 'Bob']);

    const { db } = await openEncrypted(sqlite3, DB_NAME, KEY_BYTES);

    expect(selectNames(db)).toEqual(['Alice', 'Bob']);
  });

  it('keeps accepting writes after restoring a flushed database', async () => {
    const directory = new FakeOpfsDirectory();
    await writePeopleAndFlush(directory, ['Alice']);
    await writePeopleAndFlush(directory, ['Bob']);

    const { db } = await openEncrypted(sqlite3, DB_NAME, KEY_BYTES);

    expect(selectNames(db)).toEqual(['Alice', 'Bob']);
  });

  it('opens an empty database when the stored file was encrypted with a different key', async () => {
    const directory = new FakeOpfsDirectory();
    await writePeopleAndFlush(directory, ['Alice']);

    const { db } = await openEncrypted(sqlite3, DB_NAME, OTHER_KEY_BYTES);

    expect(db.selectValues('SELECT name FROM sqlite_master')).toEqual([]);
  });

  it('never writes the database to OPFS in plain text', async () => {
    const directory = new FakeOpfsDirectory();
    await writePeopleAndFlush(directory, ['PlainTextMarker']);

    const stored = new TextDecoder('latin1').decode(directory.files.get(ENCRYPTED_FILE));

    expect([stored.includes('PlainTextMarker'), stored.includes('SQLite format 3')]).toEqual([false, false]);
  });

  it('throws and frees the buffer when SQLite cannot load the stored bytes', async () => {
    const directory = new FakeOpfsDirectory();
    directory.files.set(ENCRYPTED_FILE, await encrypt(KEY_BYTES, new Uint8Array([1, 2, 3])));
    installOpfs(directory);
    const dealloc = vi.fn();
    const failingSqlite = {
      oo1: { DB: class { pointer = 1; } },
      wasm: { allocFromTypedArray: () => 42, dealloc },
      capi: { sqlite3_deserialize: () => 26 },
    } as unknown as Sqlite3;

    await expect(openEncrypted(failingSqlite, DB_NAME, KEY_BYTES)).rejects.toThrow('sqlite3_deserialize failed with code 26');
    expect(dealloc).toHaveBeenCalledWith(42);
  });

  it('silently skips the flush when OPFS is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const { db, cryptoKey, encryptedFileName } = await openEncrypted(sqlite3, DB_NAME, KEY_BYTES);

    await expect(flushEncrypted(sqlite3, db, cryptoKey, encryptedFileName)).resolves.toBeUndefined();
  });

  describe('when an orphaned swap file blocks the write', () => {
    async function flushWith(directory: FakeOpfsDirectory): Promise<void> {
      installOpfs(directory);
      const { db, cryptoKey, encryptedFileName } = await openEncrypted(sqlite3, DB_NAME, KEY_BYTES);
      db.exec('CREATE TABLE people (name TEXT); INSERT INTO people VALUES (\'Alice\')');
      await flushEncrypted(sqlite3, db, cryptoKey, encryptedFileName);
    }

    it('moves the swap file aside and retries, so the data is persisted', async () => {
      const directory = new FakeOpfsDirectory();
      directory.files.set(SWAP_FILE, new Uint8Array([9]));
      directory.createWritableBehaviours.push(swapFileError);
      await flushWith(directory);

      const { db } = await openEncrypted(sqlite3, DB_NAME, KEY_BYTES);

      expect([selectNames(db), directory.files.has(SWAP_FILE), Array.from(directory.files.get(SWAP_BACKUP_FILE) ?? [])])
        .toEqual([['Alice'], false, [9]]);
    });

    it('replaces an older backup of the swap file', async () => {
      const directory = new FakeOpfsDirectory();
      directory.files.set(SWAP_FILE, new Uint8Array([9]));
      directory.files.set(SWAP_BACKUP_FILE, new Uint8Array([1]));
      directory.createWritableBehaviours.push(swapFileError);

      await flushWith(directory);

      expect(Array.from(directory.files.get(SWAP_BACKUP_FILE) ?? [])).toEqual([9]);
    });

    it('gives up without throwing, and writes nothing, when there is no swap file to move', async () => {
      const directory = new FakeOpfsDirectory();
      directory.createWritableBehaviours.push(swapFileError);

      await flushWith(directory);

      expect(directory.files.get(ENCRYPTED_FILE)?.byteLength).toBe(0);
    });

    it('gives up without throwing, and writes nothing, when the retry also fails', async () => {
      const directory = new FakeOpfsDirectory();
      directory.files.set(SWAP_FILE, new Uint8Array([9]));
      directory.createWritableBehaviours.push(swapFileError, swapFileError);

      await flushWith(directory);

      expect(directory.files.get(ENCRYPTED_FILE)?.byteLength).toBe(0);
    });
  });

  it.each([
    ['an unrelated error', () => { throw new Error('Quota exceeded'); }, 'Quota exceeded'],
    ['a non-Error value', () => { throw 'bad'; }, 'bad'],
  ])('rethrows %s from opening the file for writing', async (_label, behaviour, expected) => {
    const directory = new FakeOpfsDirectory();
    directory.createWritableBehaviours.push(behaviour);
    installOpfs(directory);
    const { db, cryptoKey, encryptedFileName } = await openEncrypted(sqlite3, DB_NAME, KEY_BYTES);

    await expect(flushEncrypted(sqlite3, db, cryptoKey, encryptedFileName)).rejects.toThrow(expected);
  });

  it('closes the file even when writing fails', async () => {
    const directory = new FakeOpfsDirectory();
    installOpfs(directory);
    const { db, cryptoKey, encryptedFileName } = await openEncrypted(sqlite3, DB_NAME, KEY_BYTES);
    const handle = await directory.getFileHandle(ENCRYPTED_FILE, { create: true });
    vi.spyOn(directory, 'getFileHandle').mockResolvedValue({
      ...handle,
      createWritable: async () => ({
        write: async () => { throw new Error('disk full'); },
        close: async () => { directory.closedWritables++; },
      }),
    });

    await expect(flushEncrypted(sqlite3, db, cryptoKey, encryptedFileName)).rejects.toThrow('disk full');
    expect(directory.closedWritables).toBe(1);
  });
});

// ─── registerRegexp ───────────────────────────────────────────────────────────

describe('registerRegexp', () => {
  it.each([
    ['matches', '^Al', 'Alice', 1],
    ['does not match', '^Bo', 'Alice', 0],
    ['is an invalid pattern', '([', 'Alice', 0],
  ])('makes REGEXP return the expected result when the pattern %s', (_label, pattern, value, expected) => {
    const db = new sqlite3.oo1.DB(':memory:', 'ct');
    registerRegexp(sqlite3, db);

    const result = db.selectValue('SELECT ? REGEXP ?', [value, pattern]);

    expect(result).toBe(expected);
  });
});

// ─── Web Lock helpers ─────────────────────────────────────────────────────────

describe('acquireDbLock and releaseDbLock', () => {
  type LockCallback = (lock: object | null) => Promise<void>;

  interface FakeLocks {
    request: ReturnType<typeof vi.fn>;
    /** Resolves once the lock callback's "held" promise settles, i.e. the lock is released. */
    released: () => Promise<void> | undefined;
  }

  function installLocks(isAvailable: boolean): FakeLocks {
    let held: Promise<void> | undefined;
    const request = vi.fn((_name: string, _options: object, callback: LockCallback) => {
      held = callback(isAvailable ? {} : null);
      return held;
    });
    vi.stubGlobal('navigator', { locks: { request } });
    return { request, released: () => held };
  }

  it('acquires the named lock without waiting when it is free', async () => {
    const { request } = installLocks(true);
    const lockRef: LockRef = { release: null };

    const acquired = await acquireDbLock(DB_NAME, lockRef);

    expect([acquired, request.mock.calls[0]?.slice(0, 2), typeof lockRef.release])
      .toEqual([true, [`mxdb-db-${DB_NAME}`, { ifAvailable: true }], 'function']);
  });

  it('reports false and holds nothing when another context holds the lock', async () => {
    installLocks(false);
    const lockRef: LockRef = { release: null };

    const acquired = await acquireDbLock(DB_NAME, lockRef);

    expect([acquired, lockRef.release]).toEqual([false, null]);
  });

  it('reports true without requesting again when this context already holds the lock', async () => {
    const { request } = installLocks(true);
    const lockRef: LockRef = { release: () => undefined };

    const acquired = await acquireDbLock(DB_NAME, lockRef);

    expect([acquired, request.mock.calls.length]).toEqual([true, 0]);
  });

  it.each([
    ['there is no navigator', undefined],
    ['the Locks API is unavailable', {}],
  ])('reports true when %s', async (_label, navigatorValue) => {
    vi.stubGlobal('navigator', navigatorValue);

    expect(await acquireDbLock(DB_NAME, { release: null })).toBe(true);
  });

  it('releases a held lock and clears the reference', async () => {
    const { released } = installLocks(true);
    const lockRef: LockRef = { release: null };
    await acquireDbLock(DB_NAME, lockRef);

    releaseDbLock(lockRef);

    await expect(released()).resolves.toBeUndefined();
    expect(lockRef.release).toBeNull();
  });

  it('does nothing when releasing a lock that is not held', () => {
    const lockRef: LockRef = { release: null };

    expect(() => releaseDbLock(lockRef)).not.toThrow();
  });
});
