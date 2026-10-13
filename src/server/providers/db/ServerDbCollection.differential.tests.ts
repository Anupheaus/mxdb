// sc-2518: device and server must read every whitelisted filter the same way. Random filters from the whitelist grammar
// run against the same records on the device (DbCollection on SQLite, with its in-memory evaluator) and on the server
// (ServerDbCollection on MongoDB), and both must return exactly the same records — as server code passes a filter and
// as a client sends one (normalised, then JSON).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ulid } from 'ulidx';
import { to, type DataFilters, type Logger } from '@anupheaus/common';
import { defineCollection } from '../../../common/defineCollection';
import { normaliseFilterConditions } from '../../../common/filters';
import {
  DIFFERENTIAL_CASES_PER_SEED, DIFFERENTIAL_NAMED_CASES, DIFFERENTIAL_RECORDS, DIFFERENTIAL_SEEDS, generateDifferentialCases, type DifferentialRecord,
} from '../../../common/filters/filterDifferentialCases.fixture';
import { SqliteWorkerClient } from '../../../client/db-worker/SqliteWorkerClient';
import { buildTableDDL } from '../../../client/db-worker/buildTableDDL';
import { DbCollection } from '../../../client/providers/dbs/DbCollection';
import { ServerDbCollection } from './ServerDbCollection';

vi.mock('@anupheaus/nexus/server', async importOriginal => {
  const actual = await importOriginal() as object;
  return { ...actual, useAuthentication: () => ({ user: undefined }) };
});

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), silly: vi.fn(), createSubLogger: vi.fn().mockReturnThis() } as unknown as Logger;
const collectionDefinition = defineCollection<DifferentialRecord>({ name: 'differential_records', indexes: [], disableAudit: true });

let mongod: MongoMemoryReplSet;
let client: MongoClient;
let server: ServerDbCollection<DifferentialRecord>;
let device: DbCollection<DifferentialRecord>;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(mongod.getUri());
  await client.connect();
  const db = client.db('differential');
  await db.createCollection(collectionDefinition.name);
  server = new ServerDbCollection<DifferentialRecord>({
    getDb: () => Promise.resolve(db), collection: collectionDefinition, collectionNames: Promise.resolve(new Set([collectionDefinition.name])), logger,
  });
  await server.upsert(DIFFERENTIAL_RECORDS);

  const worker = new SqliteWorkerClient();
  device = new DbCollection<DifferentialRecord>(worker, worker.open(collectionDefinition.name, buildTableDDL(collectionDefinition.name, [], true)), { name: collectionDefinition.name, indexes: [] });
  await device.whenReady();
  // As the device holds them after a sync: the records' JSON round trip, revived.
  device.batchApplyServerWriteSync(DIFFERENTIAL_RECORDS.map(record => ({ record: to.deserialise<DifferentialRecord>(to.serialise(record)), lastAuditEntryId: ulid() })));
}, 90_000);

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

const sorted = (ids: string[]) => [...ids].sort();

/** How many filters run against MongoDB at once. */
const DIFFERENTIAL_BATCH_SIZE = 200;
/** How many differing filters a failure prints in full. */
const REPORTED_DIFFERENCES = 15;
/** One seed's filters against an in-memory mongod, with room for a loaded CI runner. */
const DIFFERENTIAL_SEED_TIMEOUT = 240_000;

async function readOnBothEngines(filters: DataFilters<DifferentialRecord>) {
  const deviceIds = sorted((await device.query({ filters })).records.map(({ id }) => id));
  const serverIds = sorted((await server.query({ filters })).data.ids());
  // As the socket carries a client's request: Nexus serialises it with `to.serialise` (DateTimes survive, undefined does not).
  const sent = to.deserialise<DataFilters<DifferentialRecord>>(to.serialise({ filters: normaliseFilterConditions(filters) })) as { filters?: DataFilters<DifferentialRecord> };
  const sentIds = sorted((await server.query({ filters: sent.filters })).data.ids());
  return { deviceIds, serverIds, sentIds };
}

describe('device and server read a whitelisted filter the same way', () => {
  it.each(DIFFERENTIAL_NAMED_CASES)('%s', async (_label, filters) => {
    const { deviceIds, serverIds, sentIds } = await readOnBothEngines(filters);
    expect({ deviceIds, sentIds }).toEqual({ deviceIds: serverIds, sentIds: serverIds });
  });

  // 20,000 random filters over several seeds. One test per seed, run a batch at a time, reporting every filter that
  // reads differently (the first few in full) rather than stopping at the first.
  it.each(DIFFERENTIAL_SEEDS)(`seed %i: ${DIFFERENTIAL_CASES_PER_SEED} random filters read the same on device and server`, async seed => {
    const differences: string[] = [];
    const cases = generateDifferentialCases(seed);
    for (let start = 0; start < cases.length; start += DIFFERENTIAL_BATCH_SIZE) {
      const batch = cases.slice(start, start + DIFFERENTIAL_BATCH_SIZE);
      const results = await Promise.all(batch.map(readOnBothEngines));
      results.forEach(({ deviceIds, serverIds, sentIds }, offset) => {
        if (deviceIds.join() === serverIds.join() && sentIds.join() === serverIds.join()) return;
        differences.push(`${to.serialise(batch[offset])} → device ${deviceIds.join()} | server ${serverIds.join()} | sent ${sentIds.join()}`);
      });
    }
    expect({ count: differences.length, first: differences.slice(0, REPORTED_DIFFERENCES) }).toEqual({ count: 0, first: [] });
  }, DIFFERENTIAL_SEED_TIMEOUT);

  it('answers a catastrophic-looking pattern at once on the device (it is not a pattern MXDB accepts)', async () => {
    await device.upsert({ id: 'slow', name: `${'a'.repeat(40)}!` });
    const started = performance.now();
    await device.query({ filters: { name: { $regex: '^(a+)+$' } } });
    expect(performance.now() - started).toBeLessThan(200);
  });
});
