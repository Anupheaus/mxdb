import type { MXDBCollectionIndex } from '../../common/models';

export const LIVE_TABLE_SUFFIX = '_live';
export const AUDIT_TABLE_SUFFIX = '_audit';
export const SYNC_TABLE_SUFFIX = '_sync';

/**
 * Generates CREATE TABLE and CREATE INDEX DDL statements for a collection.
 * All statements use IF NOT EXISTS so they are idempotent.
 */
/** Double-quote an identifier so SQLite accepts any character (including hyphens). */
export function q(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * `CREATE TABLE` for a collection's audit table. The key is composite because the same audit entry id
 * legitimately appears under several records (e.g. one branch ULID applied to every record in a server
 * push). The single source for both new tables and `Db`'s migration of legacy `id TEXT PRIMARY KEY` tables.
 */
export function buildAuditTableDDL(auditTable: string): string {
  return `CREATE TABLE IF NOT EXISTS ${q(auditTable)} ` +
    '(id TEXT NOT NULL, recordId TEXT NOT NULL, type INTEGER NOT NULL, ' +
    'timestamp INTEGER NOT NULL, record TEXT, ops TEXT, PRIMARY KEY (id, recordId))';
}

export function buildTableDDL(collectionName: string, indexes: MXDBCollectionIndex[], _isAudited: boolean): string[] {
  void _isAudited;
  const liveTable = `${collectionName}${LIVE_TABLE_SUFFIX}`;
  const auditTable = `${collectionName}${AUDIT_TABLE_SUFFIX}`;
  const statements: string[] = [];

  // Live table: JSON blob per row for schema-agility
  statements.push(
    `CREATE TABLE IF NOT EXISTS ${q(liveTable)} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`
  );

  // Audit table for all collections (same sync protocol; `disableAudit` only affects server UX / validation emphasis).
  statements.push(buildAuditTableDDL(auditTable));
  statements.push(
    `CREATE INDEX IF NOT EXISTS ${q(`idx_${collectionName}_audit_by_record`)} ` +
    `ON ${q(auditTable)}(recordId, id)`
  );

  // Expression indexes over json_extract for declared collection indexes
  for (const index of indexes) {
    const fields = index.fields
      .map(field => `json_extract(data, '$.${field}')`)
      .join(', ');
    const uniqueClause = index.isUnique === true ? 'UNIQUE ' : '';
    const sparseClause = index.isSparse === true
      ? ` WHERE ${index.fields.map(f => `json_extract(data, '$.${f}') IS NOT NULL`).join(' AND ')}`
      : '';
    statements.push(
      `CREATE ${uniqueClause}INDEX IF NOT EXISTS ${q(`idx_${collectionName}_by_${index.name}`)} ` +
      `ON ${q(liveTable)}(${fields})${sparseClause}`
    );
  }

  return statements;
}
