import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@anupheaus/common';
import type { Logger } from '@anupheaus/common';
import { auditor } from '../auditor';

vi.mock('../auditor/hash', () => ({
  hashRecord: (record: { id: string }) => Promise.resolve(`mock-hash-${record.id}`),
}));
import {
  ClientDispatcher,
  ClientReceiver,
  SYNC_ATTEMPTS_BEFORE_STALLED,
  SYNC_FAST_RETRY_ATTEMPTS,
  SYNC_RETRY_BASE_DELAY_MS,
  SYNC_RETRY_MAX_DELAY_MS,
  type ClientDispatcherRequest,
  type MXDBRecordStates,
  type MXDBRecordStatesRequest,
  type MXDBSyncEngineResponse,
} from '.';

/**
 * A record the server keeps failing to write (it answers without acknowledging it, or the dispatch keeps
 * throwing) must be retried with exponential backoff — a few fast retries absorb transient blips, then
 * the delay doubles up to a cap — and reported as stalled after a number of attempts. It is never
 * dropped, and it never holds up other records.
 */

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() } as unknown as Logger;
const TIMER_INTERVAL_MS = 100;
const SERVER_DID_NOT_ACCEPT = 'the server did not accept the change';

/** The delay expected after the `attempts`-th consecutive failure. */
function expectedDelayAfter(attempts: number): number {
  if (attempts <= SYNC_FAST_RETRY_ATTEMPTS) return TIMER_INTERVAL_MS;
  return Math.min(SYNC_RETRY_MAX_DELAY_MS, SYNC_RETRY_BASE_DELAY_MS * 2 ** (attempts - SYNC_FAST_RETRY_ATTEMPTS - 1));
}

function statesFor(request: MXDBRecordStatesRequest): MXDBRecordStates {
  return request.map(({ collectionName, recordIds }) => ({
    collectionName,
    records: recordIds.map(id => ({ record: { id }, audit: auditor.createAuditFrom({ id }).entries })),
  }));
}

type DispatchOutcome = (request: ClientDispatcherRequest) => Promise<MXDBSyncEngineResponse>;

const acknowledgeAll: DispatchOutcome = async request => request.map(({ collectionName, records }) => ({ collectionName, successfulRecordIds: records.map(record => record.id) }));
const acknowledgeNone: DispatchOutcome = async request => request.map(({ collectionName }) => ({ collectionName, successfulRecordIds: [] }));
const acknowledgeAllBut = (failingId: string): DispatchOutcome => async request => request.map(({ collectionName, records }) => ({
  collectionName,
  successfulRecordIds: records.map(record => record.id).filter(id => id !== failingId),
}));
const throwError = (message: string): DispatchOutcome => async () => { throw new Error(message); };

interface Harness {
  cd: ClientDispatcher;
  onStalled: ReturnType<typeof vi.fn>;
  /** When (fake ms) each dispatch that included `recordId` happened. */
  dispatchTimesOf(recordId: string): number[];
  setOutcome(outcome: DispatchOutcome): void;
}

async function startHarness({ startUpOutcome = acknowledgeAll, startUpStates = [] as MXDBRecordStates } = {}): Promise<Harness> {
  const clientReceiver = new ClientReceiver(logger, { onRetrieve: vi.fn().mockReturnValue([]), onUpdate: vi.fn().mockReturnValue([]) });
  const dispatches: { at: number; ids: string[] }[] = [];
  let outcome: DispatchOutcome = startUpOutcome;
  const onStalled = vi.fn();
  const cd = new ClientDispatcher(logger, {
    clientReceiver,
    onPayloadRequest: ((request: MXDBRecordStatesRequest) => statesFor(request)) as never,
    onDispatching: vi.fn(),
    onDispatch: async (request: ClientDispatcherRequest) => {
      dispatches.push({ at: Date.now(), ids: request.flatMap(({ records }) => records.map(record => record.id)) });
      return outcome(request);
    },
    onUpdate: vi.fn(),
    onStart: vi.fn().mockReturnValue(startUpStates),
    onStalled,
    timerInterval: TIMER_INTERVAL_MS,
  });
  cd.start();
  await vi.advanceTimersByTimeAsync(0);
  return {
    cd, onStalled,
    dispatchTimesOf: recordId => dispatches.filter(({ ids }) => ids.includes(recordId)).map(({ at }) => at),
    setOutcome: next => { outcome = next; },
  };
}

function gapsBetween(times: number[]): number[] {
  return times.slice(1).map((time, index) => time - times[index]!);
}

/** Enough fake time for `attempts` dispatches of a record that keeps failing. */
function timeForAttempts(attempts: number): number {
  let total = TIMER_INTERVAL_MS;
  for (let attempt = 1; attempt < attempts; attempt++) total += expectedDelayAfter(attempt);
  return total;
}

const ATTEMPTS_TO_REACH_CAP = 14;

const persistentFailures: Array<[string, DispatchOutcome, string]> = [
  ['the server keeps not acknowledging it', acknowledgeNone, SERVER_DID_NOT_ACCEPT],
  ['the dispatch keeps throwing', throwError('C2S sync process failed'), 'C2S sync process failed'],
];

describe('ClientDispatcher — backoff for records the server keeps failing to write', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it.each(persistentFailures)('retries fast, then doubles the delay up to the cap, when %s', async (_label, outcome) => {
    const harness = await startHarness();
    harness.setOutcome(outcome);

    harness.cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    await vi.advanceTimersByTimeAsync(timeForAttempts(ATTEMPTS_TO_REACH_CAP));

    const expectedGaps = Array.from({ length: ATTEMPTS_TO_REACH_CAP - 1 }, (_, index) => expectedDelayAfter(index + 1));
    expect(gapsBetween(harness.dispatchTimesOf('r1')).slice(0, ATTEMPTS_TO_REACH_CAP - 1)).toEqual(expectedGaps);
  });

  it.each(persistentFailures)('reports the record as stalled, once, after the attempt limit when %s', async (_label, outcome, reason) => {
    const harness = await startHarness();
    harness.setOutcome(outcome);

    harness.cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    await vi.advanceTimersByTimeAsync(timeForAttempts(SYNC_ATTEMPTS_BEFORE_STALLED + 3));

    expect(harness.onStalled.mock.calls).toEqual([[{ collectionName: 'items', recordId: 'r1', attempts: SYNC_ATTEMPTS_BEFORE_STALLED, reason }]]);
  });

  it('does not report a record that succeeds before the attempt limit', async () => {
    const harness = await startHarness();
    harness.setOutcome(acknowledgeNone);
    harness.cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    await vi.advanceTimersByTimeAsync(timeForAttempts(SYNC_ATTEMPTS_BEFORE_STALLED - 1));

    harness.setOutcome(acknowledgeAll);
    await vi.advanceTimersByTimeAsync(SYNC_RETRY_MAX_DELAY_MS);

    expect(harness.onStalled).not.toHaveBeenCalled();
  });

  it('never drops a stalled record: it keeps retrying at the capped delay until it is accepted', async () => {
    const harness = await startHarness();
    harness.setOutcome(acknowledgeNone);
    harness.cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    await vi.advanceTimersByTimeAsync(timeForAttempts(ATTEMPTS_TO_REACH_CAP));
    const attemptsSoFar = harness.dispatchTimesOf('r1').length;

    harness.setOutcome(acknowledgeAll);
    await vi.advanceTimersByTimeAsync(SYNC_RETRY_MAX_DELAY_MS * 3);

    expect(harness.dispatchTimesOf('r1').length).toBe(attemptsSoFar + 1);
  });

  it('starts from fast retries again once the record has been accepted', async () => {
    const harness = await startHarness();
    harness.setOutcome(acknowledgeNone);
    harness.cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    await vi.advanceTimersByTimeAsync(timeForAttempts(ATTEMPTS_TO_REACH_CAP));
    harness.setOutcome(acknowledgeAll);
    await vi.advanceTimersByTimeAsync(SYNC_RETRY_MAX_DELAY_MS);
    const acceptedAttempts = harness.dispatchTimesOf('r1').length;

    harness.setOutcome(acknowledgeNone);
    harness.cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    await vi.advanceTimersByTimeAsync(timeForAttempts(3));

    expect(gapsBetween(harness.dispatchTimesOf('r1').slice(acceptedAttempts))).toEqual([TIMER_INTERVAL_MS, TIMER_INTERVAL_MS]);
  });

  it('does not hold up other records while one is backing off', async () => {
    const harness = await startHarness();
    harness.setOutcome(acknowledgeAllBut('r1'));
    harness.cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    await vi.advanceTimersByTimeAsync(timeForAttempts(ATTEMPTS_TO_REACH_CAP));
    const enqueuedAt = Date.now();

    harness.cd.enqueue({ collectionName: 'items', recordId: 'r2' });
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS);

    expect(harness.dispatchTimesOf('r2').map(at => at - enqueuedAt)).toEqual([TIMER_INTERVAL_MS]);
  });

  it('does not resend a backing-off record alongside other records before its retry is due', async () => {
    const harness = await startHarness();
    harness.setOutcome(acknowledgeAllBut('r1'));
    harness.cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    await vi.advanceTimersByTimeAsync(timeForAttempts(ATTEMPTS_TO_REACH_CAP));
    const attemptsSoFar = harness.dispatchTimesOf('r1').length;

    harness.cd.enqueue({ collectionName: 'items', recordId: 'r2' });
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS);

    expect(harness.dispatchTimesOf('r1').length).toBe(attemptsSoFar);
  });

  it('backs off the start-up sweep when it keeps failing and reports it once', async () => {
    const startUpStates = statesFor([{ collectionName: 'items', recordIds: ['r1'] }]);
    const harness = await startHarness({ startUpOutcome: throwError('server unavailable'), startUpStates });

    await vi.advanceTimersByTimeAsync(timeForAttempts(ATTEMPTS_TO_REACH_CAP));

    const expectedGaps = Array.from({ length: ATTEMPTS_TO_REACH_CAP - 1 }, (_, index) => expectedDelayAfter(index + 1));
    expect([gapsBetween(harness.dispatchTimesOf('r1')).slice(0, ATTEMPTS_TO_REACH_CAP - 1), harness.onStalled.mock.calls])
      .toEqual([expectedGaps, [[{ attempts: SYNC_ATTEMPTS_BEFORE_STALLED, reason: 'server unavailable' }]]]);
  });

  it('forgets the backoff when stopped, so a fresh session starts with fast retries', async () => {
    const harness = await startHarness();
    harness.setOutcome(acknowledgeNone);
    harness.cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    await vi.advanceTimersByTimeAsync(timeForAttempts(ATTEMPTS_TO_REACH_CAP));
    harness.cd.stop();
    harness.cd.start();
    await vi.advanceTimersByTimeAsync(0);
    const restartedAttempts = harness.dispatchTimesOf('r1').length;

    harness.cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    await vi.advanceTimersByTimeAsync(timeForAttempts(3));

    expect(gapsBetween(harness.dispatchTimesOf('r1').slice(restartedAttempts))).toEqual([TIMER_INTERVAL_MS, TIMER_INTERVAL_MS]);
  });
});
