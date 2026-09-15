// Verifies the in-memory query path (queryRecordsInMemory) returns the SAME results as the SQL/worker path for
// every filter it claims to support, over a dataset with nulls, missing fields, dates, arrays and nesting.
import { describe, it, expect, beforeEach } from 'vitest';
import { DateTime } from 'luxon';
import { to, type Record, type DataRequest } from '@anupheaus/common';
import { ulid } from 'ulidx';
import { SqliteWorkerClient } from '../../db-worker/SqliteWorkerClient';
import { buildTableDDL, LIVE_TABLE_SUFFIX, q } from '../../db-worker/buildTableDDL';
import { filtersToSql } from '../../db-worker/filtersToSql';
import { sortsToSql } from '../../db-worker/sortsToSql';
import { distinctRecordsInMemory, queryRecordsInMemory } from '../../db-worker/queryRecordsInMemory';
import type { DistinctProps } from '../../../common';
import { DbCollection } from './DbCollection';
import type { MXDBCollectionConfig } from '../../../common/models';

interface Doc extends Record {
  id: string;
  name: string;
  value?: number;
  city?: string | null;
  start?: DateTime;
  nested?: { level: number };
}

const config: MXDBCollectionConfig<Doc> = { name: 'parity-docs', indexes: [] };

const dt = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' });

const docs: Doc[] = [
  { id: 'd1', name: 'Alice', value: 10, city: 'London', start: dt('2026-01-01'), nested: { level: 1 } },
  { id: 'd2', name: 'Bob', value: 20, city: 'Paris', start: dt('2026-02-01'), nested: { level: 2 } },
  { id: 'd3', name: 'Carol', value: 30, city: null, start: dt('2026-03-01'), nested: { level: 1 } },
  { id: 'd4', name: 'Dave', value: 20, city: 'London', start: dt('2026-04-01'), nested: { level: 3 } },
  { id: 'd5', name: 'Eve', city: 'Berlin', start: dt('2026-05-01'), nested: { level: 2 } }, // value missing
  { id: 'd6', name: 'Frank', value: 40, start: dt('2026-06-01'), nested: { level: 1 } }, // city missing
];

async function createCollection(): Promise<{ collection: DbCollection<Doc>; worker: SqliteWorkerClient }> {
  const worker = new SqliteWorkerClient();
  const ddl = buildTableDDL(config.name, (config.indexes ?? []) as never, true);
  const collection = new DbCollection<Doc>(worker, worker.open(config.name, ddl), config);
  await collection.whenReady();
  collection.batchApplyServerWriteSync(docs.map(record => ({ record, lastAuditEntryId: ulid() })));
  return { collection, worker };
}

describe('DbCollection query parity — in-memory vs SQL/worker', () => {
  let worker: SqliteWorkerClient;

  beforeEach(async () => {
    ({ worker } = await createCollection());
  });

  /** Run the request through the SQL/worker path exactly as DbCollection.#queryViaWorker does. */
  async function viaWorker({ filters, sorts, pagination }: DataRequest<Doc>): Promise<{ ids: string[]; total: number }> {
    const { where, params } = filtersToSql<Doc>(filters);
    const orderBy = sortsToSql<Doc>(sorts);
    const liveTable = q(`${config.name}${LIVE_TABLE_SUFFIX}`);
    let dataSql = `SELECT data FROM ${liveTable}${where ? ` WHERE ${where}` : ''}`;
    if (orderBy) dataSql += ` ORDER BY ${orderBy}`;
    const dataParams: unknown[] = [...params];
    if (pagination) { dataSql += ' LIMIT ? OFFSET ?'; dataParams.push(pagination.limit, pagination.offset ?? 0); }
    const rows = await worker.query<{ data: string }>(dataSql, dataParams);
    const records = rows.map(row => to.deserialise<Doc>(row.data));
    let total = records.length;
    if (pagination) {
      const countRows = await worker.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${liveTable}${where ? ` WHERE ${where}` : ''}`, params);
      total = countRows[0]?.cnt ?? 0;
    }
    return { ids: records.map(r => r.id), total };
  }

  function viaMemory(request: DataRequest<Doc>): { ids: string[]; total: number } {
    const result = queryRecordsInMemory<Doc>(docs, request);
    if (result == null) throw new Error('expected in-memory support for this request');
    return { ids: result.records.map(r => r.id), total: result.total };
  }

  // Filter-only requests — order between the two paths is not contractual, so compare the matched ID SET and total.
  const filterCases: Array<[string, DataRequest<Doc>]> = [
    ['no filter', {}],
    ['direct equality', { filters: { value: 20 } }],
    ['bare array ⇒ $in', { filters: { id: ['d1', 'd3'] } as never }],
    ['$in', { filters: { value: { $in: [10, 40] } } }],
    ['range $gte/$lt', { filters: { value: { $gte: 20, $lt: 40 } } }],
    ['null matches null and missing', { filters: { city: null } }],
    ['string $gt', { filters: { name: { $gt: 'C' } } }],
    ['$or', { filters: { $or: [{ value: 10 }, { city: 'Paris' }] } }],
    ['nested path', { filters: { nested: { level: 2 } } }],
    ['DateTime range', { filters: { start: { $gt: dt('2026-03-15') } } }],
  ];

  it.each(filterCases)('matches the SQL path for %s', async (_label, request) => {
    const sql = await viaWorker(request);
    const mem = viaMemory(request);
    expect(mem.ids.slice().sort()).toEqual(sql.ids.slice().sort());
    expect(mem.total).toBe(sql.total);
  });

  // Sort + pagination on a unique key (name) — order IS deterministic, so compare the ordered page and total.
  const orderedCases: Array<[string, DataRequest<Doc>]> = [
    ['sort name asc', { sorts: [['name', 'asc']] }],
    ['sort name desc', { sorts: [['name', 'desc']] }],
    ['sort name asc + paginate', { sorts: [['name', 'asc']], pagination: { limit: 2, offset: 2 } }],
    ['filter + sort name asc + paginate', { filters: { value: { $gte: 20 } }, sorts: [['name', 'asc']], pagination: { limit: 2, offset: 1 } }],
  ];

  it.each(orderedCases)('matches the SQL path (ordered) for %s', async (_label, request) => {
    const sql = await viaWorker(request);
    const mem = viaMemory(request);
    expect(mem.ids).toEqual(sql.ids);
    expect(mem.total).toBe(sql.total);
  });

  /** Run distinct through the SQL/worker path exactly as DbCollection.#distinctViaWorker does. */
  async function distinctViaWorker<Key extends keyof Doc>({ field, filters, sorts }: DistinctProps<Doc, Key>): Promise<unknown[]> {
    const { where, params } = filtersToSql<Doc>(filters);
    const orderBy = sortsToSql<Doc>(sorts);
    const liveTable = q(`${config.name}${LIVE_TABLE_SUFFIX}`);
    const fieldExpr = `json_extract(data, '$.${String(field)}')`;
    let sql = `SELECT DISTINCT ${fieldExpr} as v FROM ${liveTable}${where ? ` WHERE ${where}` : ''}`;
    if (orderBy) sql += ` ORDER BY ${orderBy}`;
    const rows = await worker.query<{ v: unknown }>(sql, params);
    return rows.map(r => r.v);
  }

  const asKeys = (values: unknown[]): string[] => values.map(v => JSON.stringify(v ?? null));

  const distinctSetCases: Array<[string, DistinctProps<Doc, keyof Doc>]> = [
    ['distinct city', { field: 'city' }],
    ['distinct value', { field: 'value' }],
    ['distinct city with filter', { field: 'city', filters: { value: { $gte: 20 } } }],
  ];

  it.each(distinctSetCases)('distinct matches the SQL path (set) for %s', async (_label, props) => {
    const sql = await distinctViaWorker(props);
    const mem = distinctRecordsInMemory<Doc, keyof Doc>(docs, props);
    expect(mem).not.toBeNull();
    expect(asKeys(mem!).sort()).toEqual(asKeys(sql).sort());
  });

  const distinctOrderedCases: Array<[string, DistinctProps<Doc, keyof Doc>]> = [
    ['distinct city sorted asc', { field: 'city', sorts: [['city', 'asc']] }],
    ['distinct city sorted desc', { field: 'city', sorts: [['city', 'desc']] }],
  ];

  it.each(distinctOrderedCases)('distinct matches the SQL path (ordered) for %s', async (_label, props) => {
    const sql = await distinctViaWorker(props);
    const mem = distinctRecordsInMemory<Doc, keyof Doc>(docs, props);
    expect(mem).not.toBeNull();
    expect(asKeys(mem!)).toEqual(asKeys(sql));
  });
});
