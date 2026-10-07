// sc-2518: every filter operator with a missing, null or wrong-type operand matches NOTHING on the device — through
// DbCollection (in-memory path, falling back to SQL) and through the SQL path alone — never every record.
import { describe, it, expect, beforeAll } from 'vitest';
import { to, type DataFilters } from '@anupheaus/common';
import { ulid } from 'ulidx';
import { SqliteWorkerClient } from '../../db-worker/SqliteWorkerClient';
import { buildTableDDL, LIVE_TABLE_SUFFIX, q } from '../../db-worker/buildTableDDL';
import { filtersToSql } from '../../db-worker/filtersToSql';
import { queryRecordsInMemory } from '../../db-worker/queryRecordsInMemory';
import { OPERAND_CASE_RECORDS, operandCasesFor, type OperandCaseRecord } from '../../../common/filters/filterOperandCases.fixture';
import { generateFuzzCases, generateGarbageCases, withMissingAsNull } from '../../../common/filters/filterFuzzCases.fixture';
import { isReadableFilter, normaliseFilterConditions } from '../../../common/filters';
import type { MXDBCollectionConfig } from '../../../common/models';
import { DbCollection } from './DbCollection';

const config: MXDBCollectionConfig<OperandCaseRecord> = { name: 'operand-cases', indexes: [] };

let worker: SqliteWorkerClient;
let collection: DbCollection<OperandCaseRecord>;

beforeAll(async () => {
  worker = new SqliteWorkerClient();
  collection = new DbCollection<OperandCaseRecord>(worker, worker.open(config.name, buildTableDDL(config.name, [], true)), config);
  await collection.whenReady();
  collection.batchApplyServerWriteSync(OPERAND_CASE_RECORDS.map(record => ({ record, lastAuditEntryId: ulid() })));
});

const sortedIds = (records: OperandCaseRecord[]) => records.map(({ id }) => id).sort();

/** The ids the SQL path alone returns for `filters`, exactly as DbCollection's worker query runs them. */
async function viaSql(filters: DataFilters<OperandCaseRecord>): Promise<string[]> {
  const { where, params } = filtersToSql<OperandCaseRecord>(filters);
  const rows = await worker.query<{ data: string }>(`SELECT data FROM ${q(`${config.name}${LIVE_TABLE_SUFFIX}`)}${where ? ` WHERE ${where}` : ''}`, params);
  return sortedIds(rows.map(({ data }) => to.deserialise<OperandCaseRecord>(data)));
}

describe('filter operands on the device', () => {
  it.each(operandCasesFor('device'))('%s — DbCollection.query', async (_label, { filters, expectedIds }) => {
    const { records } = await collection.query({ filters });
    expect(sortedIds(records)).toEqual(expectedIds);
  });

  it.each(operandCasesFor('device'))('%s — the SQL path alone', async (_label, { filters, expectedIds, deviceSqlIds }) => {
    expect(await viaSql(filters)).toEqual(deviceSqlIds ?? expectedIds);
  });

  // Random nested queries with one broken node at every depth: never more than the same query with the node replaced
  // by match-nothing, and in fact nothing at all — through DbCollection and through the SQL path alone.
  it.each(generateFuzzCases())('fuzz %s', async (_label, { broken, matchNothing }) => {
    const [brokenIds, matchNothingIds] = [sortedIds((await collection.query({ filters: broken })).records), sortedIds((await collection.query({ filters: matchNothing })).records)];
    expect(brokenIds.filter(id => !matchNothingIds.includes(id))).toEqual([]);
    expect(brokenIds).toEqual([]);
    const [brokenSqlIds, matchNothingSqlIds] = [await viaSql(broken), await viaSql(matchNothing)];
    expect(brokenSqlIds.filter(id => !matchNothingSqlIds.includes(id))).toEqual([]);
    expect(brokenSqlIds).toEqual([]);
  });

  // Arbitrary values of any shape: an unreadable one returns nothing on every device path; a readable one passes the
  // whitelist unchanged, so the engines evaluate it exactly as before.
  it.each(generateGarbageCases())('%s', async (_label, garbage) => {
    const filters = garbage as DataFilters<OperandCaseRecord>;
    const ids = sortedIds((await collection.query({ filters })).records);
    const sqlIds = await viaSql(filters);
    if (!isReadableFilter(garbage)) {
      expect({ ids, sqlIds }).toEqual({ ids: [], sqlIds: [] });
      return;
    }
    if (garbage != null) expect(normaliseFilterConditions(filters)).toEqual(withMissingAsNull(garbage));
  });

  it.each(operandCasesFor('device'))('%s — the in-memory path, where it answers', (_label, { filters, expectedIds }) => {
    const result = queryRecordsInMemory(OPERAND_CASE_RECORDS, { filters });
    if (result == null) return; // deferred to the SQL path, covered above
    expect(sortedIds(result.records)).toEqual(expectedIds);
  });
});
