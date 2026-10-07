// sc-2518: every filter operator with a missing, null or wrong-type operand matches NOTHING on the device — through
// DbCollection (in-memory path, falling back to SQL) and through the SQL path alone — never every record.
import { describe, it, expect, beforeAll } from 'vitest';
import { to } from '@anupheaus/common';
import { ulid } from 'ulidx';
import { SqliteWorkerClient } from '../../db-worker/SqliteWorkerClient';
import { buildTableDDL, LIVE_TABLE_SUFFIX, q } from '../../db-worker/buildTableDDL';
import { filtersToSql } from '../../db-worker/filtersToSql';
import { queryRecordsInMemory } from '../../db-worker/queryRecordsInMemory';
import { OPERAND_CASE_RECORDS, operandCasesFor, type OperandCaseRecord } from '../../../common/filters/filterOperandCases.fixture';
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

describe('filter operands on the device', () => {
  it.each(operandCasesFor('device'))('%s — DbCollection.query', async (_label, { filters, expectedIds }) => {
    const { records } = await collection.query({ filters });
    expect(sortedIds(records)).toEqual(expectedIds);
  });

  it.each(operandCasesFor('device'))('%s — the SQL path alone', async (_label, { filters, expectedIds }) => {
    const { where, params } = filtersToSql<OperandCaseRecord>(filters);
    const rows = await worker.query<{ data: string }>(`SELECT data FROM ${q(`${config.name}${LIVE_TABLE_SUFFIX}`)}${where ? ` WHERE ${where}` : ''}`, params);
    expect(sortedIds(rows.map(({ data }) => to.deserialise<OperandCaseRecord>(data)))).toEqual(expectedIds);
  });

  it.each(operandCasesFor('device'))('%s — the in-memory path, where it answers', (_label, { filters, expectedIds }) => {
    const result = queryRecordsInMemory(OPERAND_CASE_RECORDS, { filters });
    if (result == null) return; // deferred to the SQL path, covered above
    expect(sortedIds(result.records)).toEqual(expectedIds);
  });
});
