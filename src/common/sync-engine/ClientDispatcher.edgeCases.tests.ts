import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@anupheaus/common'; // installs Object.clone used by the auditor
import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import { auditor } from '../auditor';
import { ClientDispatcher } from './ClientDispatcher';
import type { ClientReceiver } from './ClientReceiver';
import type {
  ClientDispatcherRequest,
  MXDBRecordStates,
  MXDBSyncEngineResponse,
  MXDBUpdateRequest,
} from './models';
import type * as HashModule from '../auditor/hash';

vi.mock('../auditor/hash', async importOriginal => ({
  ...(await importOriginal<typeof HashModule>()),
  hashRecord: (record: MXDBRecord) => Promise.resolve(`hash-${record.id}`),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const COLLECTION = 'items';
const TIMER_INTERVAL_MS = 100;

/** The dispatcher expects a generic state reader; the fixtures only ever return plain records. */
type PayloadRequestHandler = <T extends MXDBRecord>() => MXDBRecordStates<T>;

interface Harness {
  dispatcher: ClientDispatcher;
  onDispatch: ReturnType<typeof vi.fn>;
  onUpdate: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  onStart?: () => MXDBRecordStates;
  onPayloadRequest?: () => MXDBRecordStates;
  onDispatch?: (payload: ClientDispatcherRequest) => Promise<MXDBSyncEngineResponse>;
}

function makeHarness({ onStart, onPayloadRequest, onDispatch }: HarnessOptions = {}): Harness {
  const warn = vi.fn();
  const error = vi.fn();
  const logger = { debug: vi.fn(), info: vi.fn(), warn, error, silly: vi.fn() } as unknown as Logger;
  const clientReceiver = { pause: vi.fn(), resume: vi.fn() } as unknown as ClientReceiver;
  const dispatch = vi.fn(onDispatch ?? (() => Promise.resolve([])));
  const onUpdate = vi.fn();
  const dispatcher = new ClientDispatcher(logger, {
    clientReceiver,
    onStart: onStart ?? (() => []),
    onPayloadRequest: (onPayloadRequest ?? (() => [])) as PayloadRequestHandler,
    onDispatching: vi.fn(),
    onDispatch: dispatch,
    onUpdate,
    timerInterval: TIMER_INTERVAL_MS,
  });
  return { dispatcher, onDispatch: dispatch, onUpdate, warn, error };
}

function activeState(id: string): MXDBRecordStates {
  const record = { id, name: id };
  return [{ collectionName: COLLECTION, records: [{ record, audit: auditor.createAuditFrom(record).entries }] }];
}

const ack = (...ids: string[]): MXDBSyncEngineResponse => [{ collectionName: COLLECTION, successfulRecordIds: ids }];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ─── isStarted ────────────────────────────────────────────────────────────────

describe('ClientDispatcher.isStarted', () => {
  it('is false before start', () => {
    expect(makeHarness().dispatcher.isStarted).toBe(false);
  });

  it('is true once started', () => {
    const { dispatcher } = makeHarness();

    dispatcher.start();

    expect(dispatcher.isStarted).toBe(true);
  });

  it('is false after stop', () => {
    const { dispatcher } = makeHarness();
    dispatcher.start();

    dispatcher.stop();

    expect(dispatcher.isStarted).toBe(false);
  });
});

// ─── Start-up failures ────────────────────────────────────────────────────────

describe('ClientDispatcher start-up failures', () => {
  it('logs an error instead of surfacing a rejection when gathering the initial state throws', async () => {
    const { dispatcher, error } = makeHarness({ onStart: () => { throw new Error('store unavailable'); } });

    dispatcher.start();
    await vi.runAllTimersAsync();

    expect(error).toHaveBeenCalledWith('[CD] #doStart unhandled error', expect.objectContaining({ error: 'store unavailable' }));
  });

  it('stops retrying the initial dispatch when stopped during the retry delay', async () => {
    const { dispatcher, onDispatch } = makeHarness({
      onStart: () => activeState('r1'),
      onDispatch: () => Promise.reject(new Error('socket closed')),
    });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);

    dispatcher.stop();
    await vi.runAllTimersAsync();

    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch when stopped synchronously while the initial state is being gathered', async () => {
    const self = { dispatcher: undefined as ClientDispatcher | undefined };
    const harness = makeHarness({ onStart: () => { self.dispatcher?.stop(); return activeState('r1'); } });
    self.dispatcher = harness.dispatcher;

    harness.dispatcher.start();
    await vi.runAllTimersAsync();

    expect(harness.onDispatch).not.toHaveBeenCalled();
  });
});

// ─── Timer dispatch ───────────────────────────────────────────────────────────

describe('ClientDispatcher timer dispatch', () => {
  it('warns instead of surfacing a rejection when reading queued state throws', async () => {
    const { dispatcher, warn } = makeHarness({ onPayloadRequest: () => { throw new Error('read failed'); } });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);

    dispatcher.enqueue({ collectionName: COLLECTION, recordId: 'r1' });
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS);

    expect(warn).toHaveBeenCalledWith('[CD] #timerTick unhandled error', { error: 'read failed' });
  });

  it('discards the response of a dispatch that was in flight when the dispatcher stopped', async () => {
    let resolveDispatch: ((response: MXDBSyncEngineResponse) => void) | undefined;
    const { dispatcher, onUpdate } = makeHarness({
      onPayloadRequest: () => activeState('r1'),
      onDispatch: payload => (payload.length === 0
        ? Promise.resolve([])
        : new Promise(resolve => { resolveDispatch = resolve; })),
    });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    dispatcher.enqueue({ collectionName: COLLECTION, recordId: 'r1' });
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS);

    dispatcher.stop();
    resolveDispatch!(ack('r1'));
    await vi.runAllTimersAsync();

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('re-sends a record the server did not acknowledge', async () => {
    const responses: MXDBSyncEngineResponse[] = [ack(), ack('r1')];
    const sentRecordIds: string[] = [];
    const { dispatcher } = makeHarness({
      onPayloadRequest: () => activeState('r1'),
      onDispatch: payload => {
        const ids = payload.flatMap(({ records }) => records.map(({ id }) => id));
        if (ids.length === 0) return Promise.resolve([]);
        sentRecordIds.push(...ids);
        return Promise.resolve(responses.shift() ?? []);
      },
    });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    dispatcher.enqueue({ collectionName: COLLECTION, recordId: 'r1' });

    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS * 3);

    expect(sentRecordIds).toEqual(['r1', 'r1']);
  });

  it('only reports acknowledged records to onUpdate', async () => {
    const states: MXDBRecordStates = [{ collectionName: COLLECTION, records: [...activeState('r1')[0]!.records, ...activeState('r2')[0]!.records] }];
    const { dispatcher, onUpdate } = makeHarness({
      onPayloadRequest: () => states,
      onDispatch: () => Promise.resolve(ack('r2')),
    });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    dispatcher.enqueue({ collectionName: COLLECTION, recordId: 'r1' });
    dispatcher.enqueue({ collectionName: COLLECTION, recordId: 'r2' });

    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS);

    const [[update]] = onUpdate.mock.calls as [[MXDBUpdateRequest]];
    expect(update[0]?.records?.map(({ record }) => record.id)).toEqual(['r2']);
  });

  it('does not report an acknowledged record that has no audit entries to collapse to', async () => {
    const states: MXDBRecordStates = [{ collectionName: COLLECTION, records: [{ record: { id: 'r1' }, audit: [] }] }];
    const { dispatcher, onUpdate } = makeHarness({
      onPayloadRequest: () => states,
      onDispatch: () => Promise.resolve(ack('r1')),
    });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    dispatcher.enqueue({ collectionName: COLLECTION, recordId: 'r1' });

    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS);

    expect(onUpdate).not.toHaveBeenCalled();
  });
});
