import { MongoClient } from 'mongodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MXDBError } from '../../../src/common';
import type { E2eTestRecord } from '../setup/types';
import { e2eTestCollection } from '../setup/types';
import { E2E_MONGO_DB_NAME } from '../setup/mongoConstants';
import { resetE2E, setupE2E, teardownE2E, useClient, useServer, waitUntilAsync } from '../setup';
import { newRecordId } from './utils';

/**
 * A change the server keeps failing to write for a reason other than a before-write hook (here: MongoDB
 * itself refuses the document) must not be retried flat-out forever nor silently dropped: the client
 * backs off, reports it through `onError` as `SYNC_STALLED` after a few attempts, keeps the change on the
 * device, and delivers it once the failure clears.
 */

/** Documents with this `value` are refused by a MongoDB validator installed for the test. */
const REFUSED_BY_MONGO_VALUE = 'refused-by-mongo';
/**
 * Time for the stall to surface. Each attempt times out client-side (the e2e action timeout is 20s) while
 * the server keeps retrying the refused write, so reaching the stall threshold takes ~100s.
 */
const STALL_TIMEOUT_MS = 180_000;

async function withE2eDb<T>(delegate: (db: ReturnType<MongoClient['db']>) => Promise<T>): Promise<T> {
  const client = new MongoClient(useServer().mongoUri);
  try {
    await client.connect();
    return await delegate(client.db(E2E_MONGO_DB_NAME));
  } finally {
    await client.close();
  }
}

/** Makes MongoDB refuse to store any e2e record whose value is {@link REFUSED_BY_MONGO_VALUE}. */
async function refuseWritesOfValue(): Promise<void> {
  await withE2eDb(db => db.command({
    collMod: e2eTestCollection.name,
    validator: { value: { $ne: REFUSED_BY_MONGO_VALUE } },
    validationAction: 'error',
  }));
}

async function acceptAllWrites(): Promise<void> {
  await withE2eDb(db => db.command({ collMod: e2eTestCollection.name, validator: {} }));
}

describe('e2e sync stalls (backoff and surfacing)', () => {
  beforeAll(async () => {
    await setupE2E();
  }, 90_000);

  beforeEach(async () => {
    await resetE2E();
  });

  afterEach(async () => {
    await acceptAllWrites();
  });

  afterAll(async () => {
    await teardownE2E();
  }, 30_000);

  async function serverRecord(id: string): Promise<E2eTestRecord | undefined> {
    return (await useServer().readLiveRecords()).find(record => record.id === id);
  }

  function stallFor(errors: MXDBError[], recordId: string): MXDBError | undefined {
    return errors.find(error => error.code === 'SYNC_STALLED' && error.recordId === recordId);
  }

  it('reports a change the server keeps failing to write as stalled, keeps it on the device, and delivers it once the failure clears', async () => {
    const client = useClient('a');
    await client.connect();
    await refuseWritesOfValue();
    const id = newRecordId('e2e-stalled');

    await client.upsert({ id, clientId: 'a', value: REFUSED_BY_MONGO_VALUE });
    await waitUntilAsync(async () => stallFor(client.getSyncErrors(), id) != null, `stall reported for "${id}"`, STALL_TIMEOUT_MS);
    const whileStalled = [
      stallFor(client.getSyncErrors(), id)?.collection,
      (await client.getLocalRecord(id))?.value,
      client.getPendingC2SSyncQueueSize() > 0,
      await serverRecord(id),
    ];
    await acceptAllWrites();
    await useServer().waitForLiveRecord(id, { timeoutMs: STALL_TIMEOUT_MS });

    expect([whileStalled, (await serverRecord(id))?.value]).toEqual([
      [e2eTestCollection.name, REFUSED_BY_MONGO_VALUE, true, undefined],
      REFUSED_BY_MONGO_VALUE,
    ]);
  }, 400_000);
});
