// sc-2518: every filter operator with a missing, null or wrong-type operand matches NOTHING on the device — through
// DbCollection and the in-memory evaluator it uses — never every record.
import { describe, it, expect, beforeAll } from 'vitest';
import type { DataFilters } from '@anupheaus/common';
import { ulid } from 'ulidx';
import { SqliteWorkerClient } from '../../db-worker/SqliteWorkerClient';
import { buildTableDDL } from '../../db-worker/buildTableDDL';
import { queryRecordsInMemory } from '../../db-worker/queryRecordsInMemory';
import { OPERAND_CASE_RECORDS, operandCasesFor, type OperandCaseRecord } from '../../../common/filters/filterOperandCases.fixture';
import { expectedCanonicalFilter, generateFuzzCases, generateGarbageCases } from '../../../common/filters/filterFuzzCases.fixture';
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

describe('filter operands on the device', () => {
  it.each(operandCasesFor('device'))('%s — DbCollection.query', async (_label, { filters, expectedIds }) => {
    const { records } = await collection.query({ filters });
    expect(sortedIds(records)).toEqual(expectedIds);
  });

  it.each(operandCasesFor('device'))('%s — the in-memory evaluator', (_label, { filters, expectedIds }) => {
    expect(sortedIds(queryRecordsInMemory(OPERAND_CASE_RECORDS, { filters }).records)).toEqual(expectedIds);
  });

  // Random nested queries with one broken node at every depth: never more than the same query with the node replaced
  // by match-nothing, and in fact nothing at all.
  it.each(generateFuzzCases())('fuzz %s', async (_label, { broken, matchNothing }) => {
    const [brokenIds, matchNothingIds] = [sortedIds((await collection.query({ filters: broken })).records), sortedIds((await collection.query({ filters: matchNothing })).records)];
    expect(brokenIds.filter(id => !matchNothingIds.includes(id))).toEqual([]);
    expect(brokenIds).toEqual([]);
  });

  // Arbitrary values of any shape: an unreadable one returns nothing; a readable one is made canonical (missing values
  // as null, bare lists as $in) — the one form both engines evaluate.
  it.each(generateGarbageCases())('%s', async (_label, garbage) => {
    const filters = garbage as DataFilters<OperandCaseRecord>;
    const ids = sortedIds((await collection.query({ filters })).records);
    if (!isReadableFilter(garbage)) {
      expect(ids).toEqual([]);
      return;
    }
    if (garbage != null) expect(normaliseFilterConditions(filters)).toEqual(expectedCanonicalFilter(garbage as never));
  });
});
