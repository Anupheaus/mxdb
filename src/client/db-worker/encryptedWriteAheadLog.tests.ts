// The write-ahead log on its own: real SQLite and WebCrypto, with an in-memory stand-in for its OPFS folder.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openWriteAheadLog } from './encryptedWriteAheadLog';
import type { WalDirectory } from './encryptedWriteAheadLog';
import type { OO1Db, Sqlite3 } from './sqlite-worker-shared';

interface FakeFolder extends WalDirectory {
  files: Map<string, Uint8Array>;
  /** Makes the next N log-file writes fail. */
  failNextWrites(count: number): void;
}

function createFolder(): FakeFolder {
  const files = new Map<string, Uint8Array>();
  let failingWrites = 0;
  return {
    files,
    failNextWrites(count) { failingWrites = count; },
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name) && !create) throw new DOMException(`"${name}" not found`, 'NotFoundError');
      return {
        getFile: async () => {
          const bytes = files.get(name)!;
          return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
        },
        createWritable: async () => {
          const chunks: Uint8Array[] = [];
          const isFailing = failingWrites > 0;
          if (isFailing) failingWrites--;
          return {
            write: async (data: BufferSource) => {
              if (isFailing) throw new Error('QuotaExceededError');
              chunks.push(new Uint8Array(data as ArrayBuffer));
            },
            close: async () => { files.set(name, new Uint8Array(Buffer.concat(chunks))); },
            abort: async () => { /* nothing is kept */ },
          };
        },
      };
    },
    async removeEntry(name) { files.delete(name); },
    async* keys() { yield* files.keys(); },
  };
}

async function loadSqlite(): Promise<Sqlite3> {
  const { default: init } = await import('@sqlite.org/sqlite-wasm');
  const initWithOptions = init as unknown as (options: object) => Promise<Sqlite3>;
  return initWithOptions({ print: () => { /* silence */ }, printErr: () => { /* silence */ } });
}

let sqlite3: Sqlite3;
let cryptoKey: CryptoKey;

function newDatabase(): OO1Db {
  const db = new sqlite3.oo1.DB(':memory:', 'ct');
  db.exec('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, value BLOB, n INTEGER NOT NULL DEFAULT 0)');
  return db;
}

/** Writes to `db` and logs it, as the workers do. */
function write(log: Awaited<ReturnType<typeof openWriteAheadLog>>, db: OO1Db, sql: string, params: unknown[]): Promise<void> {
  db.exec({ sql, bind: params as never });
  return log.append([{ sql, params }]);
}

/** A database rebuilt from a copy of `source` (the last snapshot) plus the log in `folder`. */
async function reopen({ snapshot, folder }: { snapshot?: Uint8Array; folder: FakeFolder }) {
  const db = newDatabase();
  if (snapshot != null) {
    const pointer = (sqlite3.wasm as unknown as { allocFromTypedArray(bytes: Uint8Array): number }).allocFromTypedArray(snapshot);
    (sqlite3.capi as unknown as { sqlite3_deserialize(...args: unknown[]): number }).sqlite3_deserialize(db.pointer, 'main', pointer, snapshot.byteLength, snapshot.byteLength, 3);
  }
  const onProblem = vi.fn();
  const log = await openWriteAheadLog({ db, cryptoKey, directory: folder, onProblem });
  return { db, log, onProblem };
}

function exportDb(db: OO1Db): Uint8Array {
  return (sqlite3.capi as unknown as { sqlite3_js_db_export(pointer: number, schema: string): Uint8Array }).sqlite3_js_db_export(db.pointer!, 'main');
}

beforeEach(async () => {
  sqlite3 ??= await loadSqlite();
  cryptoKey ??= await crypto.subtle.importKey('raw', new Uint8Array(32).fill(3), 'AES-GCM', false, ['encrypt', 'decrypt']);
});

describe('openWriteAheadLog', () => {
  it('groups writes that arrive while a log file is being written into the next file', async () => {
    const folder = createFolder();
    const { db, log } = await reopen({ folder });

    await Promise.all(Array.from({ length: 50 }, (_, index) => write(log, db, 'INSERT INTO items (id) VALUES (?)', [`item-${index}`])));
    const { db: restored } = await reopen({ folder });

    expect([folder.files.size < 50, restored.selectValue('SELECT COUNT(*) FROM items')]).toEqual([true, 50]);
  });

  it('replays the writes in the order they were made', async () => {
    const folder = createFolder();
    const { db, log } = await reopen({ folder });

    await Promise.all([
      write(log, db, 'INSERT INTO items (id, n) VALUES (?, ?)', ['a', 1]),
      write(log, db, 'UPDATE items SET n = n * 10 WHERE id = ?', ['a']),
      write(log, db, 'UPDATE items SET n = n + 2 WHERE id = ?', ['a']),
    ]);
    const { db: restored } = await reopen({ folder });

    expect(restored.selectValue('SELECT n FROM items WHERE id = ?', ['a'])).toBe(12);
  });

  it('removes the log files a written snapshot holds, and replays only what came after it', async () => {
    const folder = createFolder();
    const { db, log } = await reopen({ folder });
    await write(log, db, 'INSERT INTO items (id, n) VALUES (?, ?)', ['a', 1]);
    let snapshot: Uint8Array | undefined;

    await log.snapshot(async () => { snapshot = exportDb(db); return true; });
    const filesAfterSnapshot = folder.files.size;
    await write(log, db, 'UPDATE items SET n = n + 1 WHERE id = ?', ['a']);
    const { db: restored, log: restoredLog } = await reopen({ snapshot, folder });

    expect([filesAfterSnapshot, restoredLog.replayedCount, restored.selectValue('SELECT n FROM items WHERE id = ?', ['a'])]).toEqual([0, 1, 2]);
  });

  it('keeps the log files when the snapshot was not written', async () => {
    const folder = createFolder();
    const { db, log } = await reopen({ folder });
    await write(log, db, 'INSERT INTO items (id) VALUES (?)', ['a']);

    await log.snapshot(async () => false);
    const { db: restored } = await reopen({ folder });

    expect([folder.files.size, restored.selectValue('SELECT COUNT(*) FROM items')]).toEqual([1, 1]);
  });

  it('continues numbering after the writes it replayed, so a later write is not mistaken for one already held', async () => {
    const folder = createFolder();
    const first = await reopen({ folder });
    await write(first.log, first.db, 'INSERT INTO items (id, n) VALUES (?, ?)', ['a', 1]);

    const second = await reopen({ folder });
    await write(second.log, second.db, 'UPDATE items SET n = n + 1 WHERE id = ?', ['a']);
    const third = await reopen({ folder });

    expect(third.db.selectValue('SELECT n FROM items WHERE id = ?', ['a'])).toBe(2);
  });

  it('round-trips byte-array parameters', async () => {
    const folder = createFolder();
    const { db, log } = await reopen({ folder });

    await write(log, db, 'INSERT INTO items (id, value) VALUES (?, ?)', ['a', new Uint8Array([0, 1, 254, 255])]);
    const { db: restored } = await reopen({ folder });

    expect(Array.from(restored.selectValue('SELECT value FROM items WHERE id = ?', ['a']) as Uint8Array)).toEqual([0, 1, 254, 255]);
  });

  it('still answers a write whose log file could not be written, and reports it', async () => {
    const folder = createFolder();
    const { db, log, onProblem } = await reopen({ folder });
    folder.failNextWrites(1);

    await write(log, db, 'INSERT INTO items (id) VALUES (?)', ['a']);

    expect([folder.files.size, onProblem.mock.calls[0]?.[0]]).toEqual([0, 'A write could not be added to the write-ahead log; the next snapshot holds it']);
  });

  it('skips a logged write that cannot be replayed, reports it, and replays the rest', async () => {
    const folder = createFolder();
    const { db, log } = await reopen({ folder });
    await write(log, db, 'INSERT INTO items (id) VALUES (?)', ['a']);
    db.exec('CREATE TABLE extra (id TEXT)');
    await write(log, db, 'INSERT INTO extra (id) VALUES (?)', ['x']);
    await write(log, db, 'INSERT INTO items (id) VALUES (?)', ['b']);

    const { db: restored, onProblem } = await reopen({ folder });

    expect([restored.selectValues('SELECT id FROM items ORDER BY id'), onProblem.mock.calls.map(([message]) => message)])
      .toEqual([['a', 'b'], ['A logged write could not be replayed; it is skipped']]);
  });

  it('answers at once and logs nothing where there is no OPFS', async () => {
    const db = newDatabase();
    const log = await openWriteAheadLog({ db, cryptoKey, directory: undefined, onProblem: vi.fn() });

    await expect(write(log, db, 'INSERT INTO items (id) VALUES (?)', ['a'])).resolves.toBeUndefined();
  });
});
