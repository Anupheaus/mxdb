import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditEntryType, entriesOf } from '../../../src/common';
import { hashRecord } from '../../../src/common/auditor/hash';
import { generateUlid } from '../../../src/common/auditor/time';
import { mxdbClientToServerSyncAction } from '../../../src/common/internalActions';
import {
  formatServerLogDetail, getE2eRunLogger, resetE2E, setServerLogCallback, setupE2E, teardownE2E, useClient, useServer, waitForAllClientsIdle, waitUntilAsync,
  type E2EClientHandle, type E2eTestRecord,
} from '../setup';
import { newRecordId } from './utils';

/**
 * sc-4409: a record changed many times kept every change in its server audit, which grew by every write until MongoDB's
 * 16 MB document limit stopped the record saving at all, and slowed every save long before. Driven through the real sync:
 * the round-6 measurement (a fit mark alternating Problem, with a 4,000-character description, and Fitted).
 */

const ACTION_EVENT = 'nexus.actions';
const LONG_DESCRIPTION = 'The blind catches on the left bracket. '.repeat(103).slice(0, 4_000);
const IDLE = { stableTicksRequired: 2, pollMs: 10 };

/** The `n`th change of the run: Problem with the long description on even changes, Fitted on odd ones. */
const changeOf = (base: E2eTestRecord, step: number): E2eTestRecord => (step % 2 === 0
  ? { ...base, name: 'Problem', value: `${step}: ${LONG_DESCRIPTION}` }
  : { ...base, name: 'Fitted', value: `${step}` });

describe('e2e a record changed many times (sc-4409)', () => {
  const slowUpserts: string[] = [];

  beforeAll(async () => {
    await setupE2E();
    // Keep forwarding the server's log to the run log, and note every slow-upsert warning it writes.
    setServerLogCallback((stream, line) => {
      if (line.includes('slow upsert')) slowUpserts.push(line);
      const detail = formatServerLogDetail(stream, line);
      if (detail != null) getE2eRunLogger()?.log('server_log', detail);
    });
  }, 90_000);

  beforeEach(async () => {
    await resetE2E();
    slowUpserts.length = 0;
  });

  afterAll(async () => {
    await teardownE2E();
  }, 30_000);

  const storedAuditSize = async (id: string): Promise<number> => JSON.stringify((await useServer().readAudits()).get(id)).length;
  const storedRecord = async (id: string): Promise<E2eTestRecord | undefined> => (await useServer().readLiveRecords()).find(record => record.id === id);

  async function makeChanges(client: E2EClientHandle, base: E2eTestRecord, from: number, count: number): Promise<void> {
    for (let step = from; step < from + count; step += 1) {
      await client.upsert(changeOf(base, step));
      await waitForAllClientsIdle([client], IDLE);
    }
    await waitUntilAsync(async () => (await storedRecord(base.id))?.value?.startsWith(`${from + count - 1}`) === true, 'the last change reached the server', 30_000);
  }

  /** Sends the record exactly as the server holds it, as a device resending the same fit mark does. */
  async function resendUnchanged(client: E2EClientHandle, id: string): Promise<void> {
    const stored = (await storedRecord(id))!;
    const lastEntryId = entriesOf((await useServer().readAudits()).get(id)!).reduce((latest, { id: entryId }) => (entryId > latest ? entryId : latest), '');
    const entries = [{ type: AuditEntryType.Branched, id: lastEntryId }, { type: AuditEntryType.Updated, id: generateUlid(), ops: [{ type: 1, path: 'name', value: stored.name }] }];
    const request = [{ collectionName: 'e2eTest', records: [{ id, hash: await hashRecord(stored), entries }] }];
    const answer = await client.sendRawRequest(`${ACTION_EVENT}.${mxdbClientToServerSyncAction.name}`, request) as { error?: unknown } | undefined;
    if (answer != null && 'error' in answer && answer.error != null) throw new Error(`The resend failed: ${JSON.stringify(answer.error)}`);
  }

  it('keeps the stored history flat over 1,200 changes, takes resends for free, and keeps an offline device\'s change', async () => {
    const office = useClient('office');
    const fitter = useClient('fitter');
    await Promise.all([office.connect(), fitter.connect()]);
    await fitter.subscribeGetAll();

    const id = newRecordId('fit-mark');
    const base: E2eTestRecord = { id, clientId: 'office', name: 'To fit', value: '0', metadata: { count: 0 } };
    await office.upsert(base);
    await waitUntilAsync(async () => (await fitter.getLocalRecord(id)) != null, 'the fitter holds the blind', 30_000);
    await waitForAllClientsIdle([office, fitter]);
    const slowUpsertsAfterFirstChange = slowUpserts.length;

    // The fitter goes offline before the run and changes the blind there: a field nobody else touches, and the status.
    await fitter.disconnect();
    await fitter.upsert({ ...base, clientId: 'fitter', name: 'Fitted by the fitter', metadata: { count: 42, tag: 'gap at top' } });

    await makeChanges(office, base, 1, 48);
    const afterFewDozen = await storedAuditSize(id);
    await makeChanges(office, base, 49, 152);
    const after200 = await storedAuditSize(id);
    const sizesOverNext1000: number[] = [];
    for (let block = 0; block < 10; block += 1) {
      await makeChanges(office, base, 201 + block * 100, 100);
      sizesOverNext1000.push(await storedAuditSize(id));
    }

    // Criteria 1 and 2: no bigger after 200 than after the first few dozen, flat for 1,000 more, and no new slow saves.
    expect(after200).toBeLessThanOrEqual(afterFewDozen * 1.5);
    expect(Math.max(...sizesOverNext1000)).toBeLessThanOrEqual(afterFewDozen * 1.5);
    expect(slowUpserts.length).toBe(slowUpsertsAfterFirstChange);

    // Criterion 3: the same fit mark sent again, 100 times, leaves the stored history exactly the same size.
    const beforeResends = await storedAuditSize(id);
    for (let resend = 0; resend < 100; resend += 1) await resendUnchanged(office, id);
    expect(await storedAuditSize(id)).toBe(beforeResends);

    // Criterion 4: the fitter reconnects. Its change to the field nobody else touched is saved; its status change is
    // older than the office's 1,200 and loses to them, as it always has (last write wins); its screen shows the server's record.
    await fitter.reconnect();
    await waitForAllClientsIdle([office, fitter]);
    await waitUntilAsync(async () => (await storedRecord(id))?.metadata?.tag === 'gap at top', 'the fitter\'s change reached the server', 30_000);
    const server = (await storedRecord(id))!;
    await waitUntilAsync(async () => (await fitter.getLocalRecord(id))?.value === server.value, 'the fitter shows the server\'s record', 30_000);
    expect(await fitter.getLocalRecord(id)).toEqual(server);
    expect([server.metadata, server.name]).toEqual([{ count: 42, tag: 'gap at top' }, changeOf(base, 1_200).name]);
    // 1,300 synced writes take about 6.5 minutes on a developer machine; CI runners are slower.
  }, 1_200_000);
});
