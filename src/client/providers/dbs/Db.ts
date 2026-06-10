import { InternalError, type Logger, type Record } from '@anupheaus/common';
import { DbCollection } from './DbCollection';
import type { MXDBCollectionConfig } from '../../../common/models';
import { SqliteWorkerClient } from '../../db-worker/SqliteWorkerClient';
import { buildTableDDL } from '../../db-worker/buildTableDDL';

/** Internal auth table DDL — not part of user-defined collections. */
const AUTH_TABLE_DDL = `CREATE TABLE IF NOT EXISTS mxdb_authentication (
  id      TEXT PRIMARY KEY,
  token   TEXT NOT NULL,
  keyHash TEXT NOT NULL DEFAULT ''
)`;

export class Db {
  constructor(
    name: string,
    collections: MXDBCollectionConfig[],
    encryptionKey?: Uint8Array,
    auditorLogger?: Logger,
  ) {
    this.#name = name;
    this.#worker = new SqliteWorkerClient({ encryptionKey });
    // Open the database and ensure all tables exist, then construct collections
    this.#ready = this.#openDb(collections);
    this.#collections = new Map(
      collections.map(config => [
        config.name,
        new DbCollection(this.#worker, this.#ready, config, auditorLogger),
      ]),
    );
    // Reload the affected collection whenever another tab writes to it
    this.#worker.setOnExternalChange(collectionName => {
      this.#collections.get(collectionName)?.reloadFromWorker();
    });
  }

  #name: string;
  #worker: SqliteWorkerClient;
  #ready: Promise<void>;
  #collections: Map<string, DbCollection>;

  public get name() { return this.#name; }

  public use<RecordType extends Record>(collectionName: string): DbCollection<RecordType> {
    const collection = this.#collections.get(collectionName) as DbCollection<RecordType> | undefined;
    if (collection == null) {
      const availableCollections = Array.from(this.#collections.keys()).sort();
      throw new InternalError({
        message: `Collection "${collectionName}" is not registered in the "${this.#name}" database. `
          + `${availableCollections.length} registered collection(s): ${availableCollections.join(', ') || '(none)'}. `
          + `Add "${collectionName}" to this client's collections list (e.g. mobileCollections / webCollections), `
          + `or ensure the provider that uses it is only mounted on clients that register it.`,
        meta: { database: this.#name, requestedCollection: collectionName, availableCollections },
      });
    }
    return collection;
  }

  public async hasPendingAudits(): Promise<boolean> {
    for (const collection of this.#collections.values()) {
      if (await collection.hasPendingAudits()) return true;
    }
    return false;
  }

  public async close(): Promise<void> {
    await this.#worker.close();
  }

  /**
   * Execute a read-only SQL query and return rows as objects.
   *
   * This is intentionally minimal and does not expose the worker directly.
   */
  public async queryRaw<T extends object = { [key: string]: unknown }>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    await this.#ready;
    return this.#worker.query<T>(sql, params);
  }

  /**
   * Execute a mutating SQL statement.
   *
   * This is used by remote-assistance handlers when the consumer has explicitly
   * opted-in to allow mutating SQL for the current in-memory session.
   */
  public async execRaw(sql: string, params?: unknown[]): Promise<void> {
    await this.#ready;
    await this.#worker.exec(sql, params);
  }

  // ─── Auth token persistence (internal mxdb_authentication table) ────────────

  /** Read the stored auth credentials, or undefined if not yet stored. */
  public async readAuth(): Promise<{ token: string; keyHash: string } | undefined> {
    await this.#ready;
    const rows = await this.#worker.query<{ token: string; keyHash: string }>(
      'SELECT token, keyHash FROM mxdb_authentication WHERE id = \'singleton\' LIMIT 1',
    );
    return rows[0];
  }

  /** Persist auth credentials (replaces any existing ones). */
  public async writeAuth(token: string, keyHash: string): Promise<void> {
    await this.#ready;
    await this.#worker.exec(
      'INSERT OR REPLACE INTO mxdb_authentication(id, token, keyHash) VALUES (\'singleton\', ?, ?)',
      [token, keyHash],
    );
  }

  /** Remove the stored auth credentials (e.g. on sign-out). */
  public async clearAuth(): Promise<void> {
    await this.#ready;
    await this.#worker.exec('DELETE FROM mxdb_authentication WHERE id = \'singleton\'');
  }

  async #openDb(collections: MXDBCollectionConfig[]): Promise<void> {
    // Phase 1: open the database with just the auth table so the worker is ready for queries.
    await this.#worker.open(this.#name, [AUTH_TABLE_DDL]);

    // Phase 2: migrate audit tables from the old single-column PK schema (id TEXT PRIMARY KEY)
    // to the composite PK schema (PRIMARY KEY (id, recordId)). The audit table is a local cache —
    // the server re-syncs any entries lost during migration on next connect.
    // Run all schema checks in parallel so their queries are queued at once rather than sequentially.
    await Promise.all(collections.map(config => this.#migrateAuditTableIfNeeded(`${config.name}_audit`)));

    // Phase 3: create/ensure all collection tables (idempotent with IF NOT EXISTS).
    const collectionStatements: string[] = [];
    for (const config of collections) {
      collectionStatements.push(...buildTableDDL(config.name, config.indexes ?? [], config.disableAudit !== true));
    }
    if (collectionStatements.length > 0) {
      await this.#worker.execBatch(collectionStatements.map(sql => ({ sql })));
    }
  }

  /**
   * Detects the old single-column PRIMARY KEY schema on the audit table and migrates
   * it to the composite (id, recordId) PRIMARY KEY. Safe to call repeatedly — exits
   * immediately if the table is already on the new schema or does not exist yet.
   */
  async #migrateAuditTableIfNeeded(auditTable: string): Promise<void> {
    const rows = await this.#worker.query<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
      [auditTable],
    );
    if (rows.length === 0) return; // table does not exist yet — nothing to migrate
    const schemaSql = rows[0]!.sql ?? '';
    // Old schema has "id TEXT PRIMARY KEY" (single-column). New schema has "PRIMARY KEY (id, recordId)".
    if (!schemaSql.includes('id TEXT PRIMARY KEY')) return; // already migrated

    // Recreate with composite PK. Use a temp name to avoid DROP IF EXISTS race.
    const tempTable = `${auditTable}_migrating`;
    await this.#worker.execBatch([
      {
        sql: `CREATE TABLE IF NOT EXISTS "${tempTable}" ` +
          '(id TEXT NOT NULL, recordId TEXT NOT NULL, type INTEGER NOT NULL, ' +
          'timestamp INTEGER NOT NULL, record TEXT, ops TEXT, PRIMARY KEY (id, recordId))',
      },
      {
        sql: `INSERT OR IGNORE INTO "${tempTable}" SELECT id, recordId, type, timestamp, record, ops FROM "${auditTable}"`,
      },
      { sql: `DROP TABLE "${auditTable}"` },
      { sql: `ALTER TABLE "${tempTable}" RENAME TO "${auditTable}"` },
    ]);
  }
}
