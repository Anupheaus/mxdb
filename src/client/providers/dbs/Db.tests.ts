// Behavioural tests for Db, run against the real in-process SQLite runner (SqliteWorkerClient inline mode).
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Record } from '@anupheaus/common';
import { ulid } from 'ulidx';
import { SqliteWorkerClient } from '../../db-worker/SqliteWorkerClient';
import { AuditEntryType } from '../../../common';
import type { MXDBCollectionConfig } from '../../../common/models';
import { Db } from './Db';
import type { MXDBCollectionEvent } from './models';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

interface TestRecord extends Record {
  id: string;
  name: string;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface SchemaRow {
  sql: string;
}

const DB_NAME = 'test-db';
const configs: MXDBCollectionConfig[] = [
  { name: 'accounts', indexes: [] },
  { name: 'users', indexes: [{ name: 'name', fields: ['name'] }] },
];

const LEGACY_AUDIT_DDL = 'CREATE TABLE "accounts_audit" (id TEXT PRIMARY KEY, recordId TEXT NOT NULL, '
  + 'type INTEGER NOT NULL, timestamp INTEGER NOT NULL, record TEXT, ops TEXT)';
const MIGRATED_AUDIT_DDL = 'CREATE TABLE "accounts_audit" (id TEXT NOT NULL, recordId TEXT NOT NULL, '
  + 'type INTEGER NOT NULL, timestamp INTEGER NOT NULL, record TEXT, ops TEXT, PRIMARY KEY (id, recordId))';

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function drainMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}

/**
 * Simulate a database that already exists on disk from an older library version: every freshly opened
 * (in-memory) database is given the supplied pre-existing tables/rows before Db continues its open.
 */
function seedExistingDatabase(statements: string[]): void {
  const realOpen = SqliteWorkerClient.prototype.open;
  vi.spyOn(SqliteWorkerClient.prototype, 'open').mockImplementation(async function (this: SqliteWorkerClient, dbName, ddl) {
    await realOpen.call(this, dbName, ddl);
    await this.execBatch(statements.map(sql => ({ sql })));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Db', () => {
  it('exposes the database name', () => {
    const db = new Db(DB_NAME, configs);

    expect(db.name).toBe(DB_NAME);
  });

  it('returns the collection registered under the requested name', () => {
    const db = new Db(DB_NAME, configs);

    expect(db.use<TestRecord>('users').name).toBe('users');
  });

  it('lists "(none)" when a collection is requested from a database with no collections', () => {
    const db = new Db(DB_NAME, []);

    expect(() => db.use('users')).toThrow('0 registered collection(s): (none)');
  });

  it('creates the tables for every configured collection so they can be written and read', async () => {
    const db = new Db(DB_NAME, configs);
    await db.use<TestRecord>('users').whenReady();

    await db.execRaw('INSERT INTO "users_live"(id, data) VALUES (?, ?)', ['u1', '{"id":"u1","name":"A"}']);

    expect(await db.queryRaw('SELECT id FROM "users_live"')).toEqual([{ id: 'u1' }]);
  });

  it('creates the expression index declared on a collection', async () => {
    const db = new Db(DB_NAME, configs);

    const indexes = await db.queryRaw<{ name: string }>('SELECT name FROM sqlite_master WHERE type = \'index\' AND name = ?', ['idx_users_by_name']);

    expect(indexes).toEqual([{ name: 'idx_users_by_name' }]);
  });

  it('opens with no collections configured', async () => {
    const db = new Db(DB_NAME, []);

    expect(await db.readAuth()).toBeUndefined();
  });

  describe('hasPendingAudits', () => {
    it('is false when no collection has local changes', async () => {
      const db = new Db(DB_NAME, configs);

      expect(await db.hasPendingAudits()).toBe(false);
    });

    it('is true when any collection has a local change not yet synced', async () => {
      const db = new Db(DB_NAME, configs);
      await db.use<TestRecord>('users').upsert({ id: 'u1', name: 'A' });

      expect(await db.hasPendingAudits()).toBe(true);
    });
  });

  describe('auth token persistence', () => {
    it('reads nothing before credentials are stored', async () => {
      const db = new Db(DB_NAME, configs);

      expect(await db.readAuth()).toBeUndefined();
    });

    it('reads back the stored credentials', async () => {
      const db = new Db(DB_NAME, configs);

      await db.writeAuth('token-1', 'hash-1');

      expect(await db.readAuth()).toEqual({ token: 'token-1', keyHash: 'hash-1' });
    });

    it('replaces previously stored credentials', async () => {
      const db = new Db(DB_NAME, configs);
      await db.writeAuth('token-1', 'hash-1');

      await db.writeAuth('token-2', 'hash-2');

      expect(await db.readAuth()).toEqual({ token: 'token-2', keyHash: 'hash-2' });
    });

    it('reads nothing after credentials are cleared', async () => {
      const db = new Db(DB_NAME, configs);
      await db.writeAuth('token-1', 'hash-1');

      await db.clearAuth();

      expect(await db.readAuth()).toBeUndefined();
    });
  });

  describe('open sequencing', () => {
    it('waits for a previous close of the same database before becoming usable', async () => {
      const previousClose = createDeferred();
      const db = new Db(DB_NAME, configs, undefined, undefined, previousClose.promise);
      let isSettled = false;
      const reading = db.readAuth().then(() => { isSettled = true; });

      await drainMicrotasks();
      const settledBeforeClose = isSettled;
      previousClose.resolve();
      await reading;

      expect([settledBeforeClose, isSettled]).toEqual([false, true]);
    });

    it('still opens when the previous close failed', async () => {
      const previousClose = createDeferred();
      previousClose.reject(new Error('close failed'));
      const db = new Db(DB_NAME, configs, undefined, undefined, previousClose.promise);

      expect(await db.readAuth()).toBeUndefined();
    });
  });

  it('rejects raw queries once closed', async () => {
    const db = new Db(DB_NAME, configs);
    await db.readAuth();

    await db.close();

    await expect(db.queryRaw('SELECT 1')).rejects.toThrow('Database not open');
  });

  it('reloads a collection and notifies its subscribers when another tab reports a change to it', async () => {
    const setOnExternalChange = vi.spyOn(SqliteWorkerClient.prototype, 'setOnExternalChange');
    const db = new Db(DB_NAME, configs);
    const users = db.use<TestRecord>('users');
    await users.whenReady();
    const events: MXDBCollectionEvent<TestRecord>[] = [];
    users.onChange(event => events.push(event));
    const [notifyExternalChange] = setOnExternalChange.mock.calls[0]!;
    // Another tab's write, landing directly in SQLite.
    await db.execRaw('INSERT INTO "users_live"(id, data) VALUES (?, ?)', ['u1', '{"id":"u1","name":"Other tab"}']);
    await db.execRaw(
      'INSERT INTO "users_audit"(id, recordId, type, timestamp, record, ops) VALUES (?, ?, ?, 0, NULL, NULL)',
      [ulid(), 'u1', AuditEntryType.Branched],
    );

    notifyExternalChange('users');
    await drainMicrotasks();

    expect(events).toEqual([{ type: 'reload', records: [{ id: 'u1', name: 'Other tab' }] }]);
  });

  it('ignores external change notifications for collections it does not hold', () => {
    const setOnExternalChange = vi.spyOn(SqliteWorkerClient.prototype, 'setOnExternalChange');
    new Db(DB_NAME, configs);
    const [notifyExternalChange] = setOnExternalChange.mock.calls[0]!;

    expect(() => notifyExternalChange('unknown')).not.toThrow();
  });

  describe('legacy audit table migration', () => {
    it('migrates a single-column primary key audit table to the composite (id, recordId) key', async () => {
      seedExistingDatabase([LEGACY_AUDIT_DDL]);
      const db = new Db(DB_NAME, configs);

      const [schema] = await db.queryRaw<SchemaRow>('SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = ?', ['accounts_audit']);

      expect(schema?.sql).toContain('PRIMARY KEY (id, recordId)');
    });

    it('keeps existing audit entries when migrating so the collection still sees them', async () => {
      const entryId = ulid();
      seedExistingDatabase([
        LEGACY_AUDIT_DDL,
        `INSERT INTO "accounts_audit"(id, recordId, type, timestamp, record, ops) VALUES ('${entryId}', 'a1', ${AuditEntryType.Branched}, 0, NULL, NULL)`,
      ]);
      const db = new Db(DB_NAME, configs);

      const audit = await db.use<TestRecord>('accounts').getAudit('a1');

      expect(audit?.entries).toEqual([{ id: entryId, type: AuditEntryType.Branched }]);
    });

    it('leaves an already-migrated audit table unchanged', async () => {
      seedExistingDatabase([MIGRATED_AUDIT_DDL]);
      const db = new Db(DB_NAME, configs);

      const [schema] = await db.queryRaw<SchemaRow>('SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = ?', ['accounts_audit']);

      expect(schema?.sql).toBe(MIGRATED_AUDIT_DDL);
    });
  });
});
