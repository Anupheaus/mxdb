// sc-2518: every filter operator with a missing, null or wrong-type operand matches NOTHING on the device — through
// DbCollection and the in-memory evaluator it uses — never every record.
import { describe, it, expect, beforeAll } from 'vitest';
import type { DataFilters } from '@anupheaus/common';
import { ulid } from 'ulidx';
import { SqliteWorkerClient } from '../../db-worker/SqliteWorkerClient';
import { buildTableDDL } from '../../db-worker/buildTableDDL';
import { queryRecordsInMemory } from '../../db-worker/queryRecordsInMemory';
import {
  OPERAND_CASE_RECORDS, PARITY_CASE_RECORDS, operandCasesFor, parityCases, type OperandCaseRecord, type ParityCaseRecord,
} from '../../../common/filters/filterOperandCases.fixture';
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

  // sc-2783: comparisons across kinds, "does not exist", nested conditions and case-insensitive patterns.
  describe('the filters that once read differently from the server (sc-2783)', () => {
    let parityCollection: DbCollection<ParityCaseRecord>;

    beforeAll(async () => {
      const parityConfig: MXDBCollectionConfig<ParityCaseRecord> = { name: 'parity-cases', indexes: [] };
      parityCollection = new DbCollection<ParityCaseRecord>(worker, worker.open(parityConfig.name, buildTableDDL(parityConfig.name, [], true)), parityConfig);
      await parityCollection.whenReady();
      parityCollection.batchApplyServerWriteSync(PARITY_CASE_RECORDS.map(record => ({ record, lastAuditEntryId: ulid() })));
    });

    it.each(parityCases())('%s — DbCollection.query', async (_label, { filters, expectedIds }) => {
      const { records } = await parityCollection.query({ filters: filters as DataFilters<ParityCaseRecord> });
      expect(records.map(({ id }) => id).sort()).toEqual(expectedIds);
    });

    it.each(parityCases())('%s — the in-memory evaluator', (_label, { filters, expectedIds }) => {
      const { records } = queryRecordsInMemory(PARITY_CASE_RECORDS, { filters: filters as DataFilters<ParityCaseRecord> });
      expect(records.map(({ id }) => id).sort()).toEqual(expectedIds);
    });
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
