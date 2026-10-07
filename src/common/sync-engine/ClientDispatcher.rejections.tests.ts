import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@anupheaus/common';
import type { Logger } from '@anupheaus/common';
import { auditor } from '../auditor';

vi.mock('../auditor/hash', () => ({
  hashRecord: (record: { id: string }) => Promise.resolve(`mock-hash-${record.id}`),
}));
import { ClientDispatcher, ClientReceiver, type MXDBRecordStates, type MXDBSyncEngineResponse } from '.';

/**
 * When the server refuses a synced record (a collection before-write hook threw), it still acknowledges
 * it and reports it in `rejectedRecords`. The dispatcher must stop resending it like any acknowledged
 * record and tell the app which record was refused and why.
 */

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() } as unknown as Logger;
const TIMER_INTERVAL_MS = 100;

function statesFor(...ids: string[]): MXDBRecordStates {
  return [{ collectionName: 'items', records: ids.map(id => ({ record: { id }, audit: auditor.createAuditFrom({ id }).entries })) }];
}

interface Harness {
  cd: ClientDispatcher;
  onDispatch: ReturnType<typeof vi.fn<() => Promise<MXDBSyncEngineResponse>>>;
  onRejected: ReturnType<typeof vi.fn>;
  onAmended: ReturnType<typeof vi.fn>;
  onUpdate: ReturnType<typeof vi.fn>;
}

function createHarness(response: MXDBSyncEngineResponse, initialStates: MXDBRecordStates = []): Harness {
  const clientReceiver = new ClientReceiver(logger, { onRetrieve: vi.fn().mockReturnValue([]), onUpdate: vi.fn().mockReturnValue([]) });
  const onDispatch = vi.fn<() => Promise<MXDBSyncEngineResponse>>().mockResolvedValue(response);
  const onRejected = vi.fn();
  const onAmended = vi.fn();
  const onUpdate = vi.fn();
  const cd = new ClientDispatcher(logger, {
    clientReceiver,
    onPayloadRequest: vi.fn().mockReturnValue(statesFor('r1', 'r2')) as never,
    onDispatching: vi.fn(),
    onDispatch,
    onUpdate,
    onStart: vi.fn().mockReturnValue(initialStates),
    onRejected,
    onAmended,
    timerInterval: TIMER_INTERVAL_MS,
  });
  return { cd, onDispatch, onRejected, onAmended, onUpdate };
}

const rejectingResponse: MXDBSyncEngineResponse = [{
  collectionName: 'items',
  successfulRecordIds: ['r1', 'r2'],
  rejectedRecords: [{ id: 'r1', reason: 'not allowed', kind: 'validation' }],
}];

describe('ClientDispatcher — records the server rejected', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('tells the app which records were rejected and why', async () => {
    const { cd, onRejected } = createHarness(rejectingResponse);
    cd.start();
    await vi.runOnlyPendingTimersAsync();

    cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    cd.enqueue({ collectionName: 'items', recordId: 'r2' });
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS);

    expect(onRejected.mock.calls).toEqual([[[{ collectionName: 'items', recordId: 'r1', reason: 'not allowed', kind: 'validation' }]]]);
  });

  it('reports rejections from the start-up sweep too', async () => {
    const { cd, onRejected } = createHarness(rejectingResponse, statesFor('r1', 'r2'));

    cd.start();
    await vi.runOnlyPendingTimersAsync();

    expect(onRejected.mock.calls).toEqual([[[{ collectionName: 'items', recordId: 'r1', reason: 'not allowed', kind: 'validation' }]]]);
  });

  it('settles a rejected record like any acknowledged one and does not resend it', async () => {
    const { cd, onDispatch, onUpdate } = createHarness(rejectingResponse);
    cd.start();
    await vi.runOnlyPendingTimersAsync();
    onDispatch.mockClear();

    cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    cd.enqueue({ collectionName: 'items', recordId: 'r2' });
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS * 20);

    expect([onDispatch.mock.calls.length, onUpdate.mock.lastCall![0][0].records.map((settled: { record: { id: string } }) => settled.record.id)])
      .toEqual([1, ['r1', 'r2']]);
  });

  it('reports a rejection from a server that sends no kind without one, so the app can treat it as unknown', async () => {
    const { cd, onRejected } = createHarness([{ collectionName: 'items', successfulRecordIds: ['r1', 'r2'], rejectedRecords: [{ id: 'r1', reason: 'not allowed' }] }], statesFor('r1', 'r2'));

    cd.start();
    await vi.runOnlyPendingTimersAsync();

    expect(onRejected.mock.calls).toEqual([[[{ collectionName: 'items', recordId: 'r1', reason: 'not allowed' }]]]);
  });

  it('reports nothing when the server rejects nothing', async () => {
    const { cd, onRejected } = createHarness([{ collectionName: 'items', successfulRecordIds: ['r1', 'r2'] }], statesFor('r1', 'r2'));

    cd.start();
    await vi.runOnlyPendingTimersAsync();

    expect(onRejected).not.toHaveBeenCalled();
  });
});

describe('ClientDispatcher — records the server saved but amended with a note', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  const amendingResponse: MXDBSyncEngineResponse = [{
    collectionName: 'items',
    successfulRecordIds: ['r1', 'r2'],
    amendedRecords: [{ id: 'r1', note: 'The name was put back.' }, { id: 'r2', note: 'The colour was put back.' }],
  }];

  it('hands the app every note from one response in a single call', async () => {
    const { cd, onAmended } = createHarness(amendingResponse, statesFor('r1', 'r2'));

    cd.start();
    await vi.runOnlyPendingTimersAsync();

    expect(onAmended.mock.calls).toEqual([[[
      { collectionName: 'items', recordId: 'r1', note: 'The name was put back.' },
      { collectionName: 'items', recordId: 'r2', note: 'The colour was put back.' },
    ]]]);
  });

  it('ignores a note for a record this dispatch did not carry', async () => {
    const { cd, onAmended } = createHarness([{ collectionName: 'items', successfulRecordIds: ['r1'], amendedRecords: [{ id: 'other', note: 'Not ours.' }] }], statesFor('r1'));

    cd.start();
    await vi.runOnlyPendingTimersAsync();

    expect(onAmended).not.toHaveBeenCalled();
  });

  it('reports nothing from a server that sends no amendments (older than mxdb 0.2.8)', async () => {
    const { cd, onAmended } = createHarness([{ collectionName: 'items', successfulRecordIds: ['r1', 'r2'] }], statesFor('r1', 'r2'));

    cd.start();
    await vi.runOnlyPendingTimersAsync();

    expect(onAmended).not.toHaveBeenCalled();
  });

  it('settles an amended record like any acknowledged one and does not resend it', async () => {
    const { cd, onDispatch } = createHarness(amendingResponse);
    cd.start();
    await vi.runOnlyPendingTimersAsync();
    onDispatch.mockClear();

    cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    cd.enqueue({ collectionName: 'items', recordId: 'r2' });
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS * 20);

    expect(onDispatch).toHaveBeenCalledTimes(1);
  });
});
