import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@anupheaus/common';
import { ServerDispatcher } from './ServerDispatcher';
import type { MXDBActiveRecordCursor, MXDBRecordCursors, MXDBSyncEngineResponse } from './models';

// A dispatch that fails for any reason other than the client being paused (socket dropped
// mid-emit, transport error, client handler threw) happens inside fire-and-forget
// `push()`/`resume()`/retry calls. It must never escape as an unhandled rejection — under
// Node's default policy that terminates the server and disconnects every client.

const COLLECTION = 'items';
const RETRY_INTERVAL_MS = 100;

const active = (id: string, lastAuditEntryId: string): MXDBActiveRecordCursor & { hash: string } =>
  ({ record: { id }, lastAuditEntryId, hash: `hash-${lastAuditEntryId}` });
const batch = (...records: MXDBActiveRecordCursor[]): MXDBRecordCursors => [{ collectionName: COLLECTION, records }];
const ackAll = (payload: MXDBRecordCursors): MXDBSyncEngineResponse =>
  payload.map(({ collectionName, records }) => ({
    collectionName,
    successfulRecordIds: records.map(cursor => ('record' in cursor ? cursor.record.id : cursor.recordId)),
  }));
const sentIds = (payload: MXDBRecordCursors) =>
  payload.flatMap(({ records }) => records.map(cursor => ('record' in cursor ? cursor.record.id : cursor.recordId)));

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() };
}

interface FailingDispatcherOptions {
  /** Number of initial dispatches that reject before the client starts acknowledging. */
  failures: number;
  error?: Error;
}

function makeFailingDispatcher({ failures, error = new Error('socket has been disconnected') }: FailingDispatcherOptions) {
  const logger = makeLogger();
  const attempts: MXDBRecordCursors[] = [];
  const onDispatch = vi.fn(async (payload: MXDBRecordCursors): Promise<MXDBSyncEngineResponse> => {
    attempts.push(payload);
    if (attempts.length <= failures) throw error;
    return ackAll(payload);
  });
  const sd = new ServerDispatcher(logger as unknown as Logger, { onDispatch, retryInterval: RETRY_INTERVAL_MS });
  return { sd, attempts, logger };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); // real setImmediate: lets Node report unhandled rejections
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Let pending microtasks (and Node's unhandled-rejection detection) run. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await new Promise(resolve => setImmediate(resolve));
}

describe('ServerDispatcher when a dispatch fails', () => {
  it.each([
    ['push', (sd: ServerDispatcher) => sd.push(batch(active('a', '01A')))],
    ['resume', (sd: ServerDispatcher) => { sd.pause(); sd.push(batch(active('a', '01A'))); sd.resume(); }],
  ])('does not surface an unhandled rejection from %s', async (_label, trigger) => {
    const { sd } = makeFailingDispatcher({ failures: 1 });

    trigger(sd);
    await settle();

    expect(unhandled).toEqual([]);
  });

  it('logs the failure with the underlying error', async () => {
    const error = new Error('transport close');
    const { sd, logger } = makeFailingDispatcher({ failures: 1, error });

    sd.push(batch(active('a', '01A')));
    await settle();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('dispatch failed'), expect.objectContaining({ error }));
  });

  it('redelivers the undelivered records on its own, without waiting for another push', async () => {
    const { sd, attempts } = makeFailingDispatcher({ failures: 1 });

    sd.push(batch(active('a', '01A')));
    await settle();
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);

    expect(attempts.map(sentIds)).toEqual([['a'], ['a']]);
  });

  it('keeps later pushes queued behind a failure and delivers them together once it recovers', async () => {
    const { sd, attempts } = makeFailingDispatcher({ failures: 1 });

    sd.push(batch(active('a', '01A')));
    await settle();
    sd.push(batch(active('b', '01B')));
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);

    expect(attempts.at(-1) && sentIds(attempts.at(-1)!).sort()).toEqual(['a', 'b']);
  });

  it('backs off between consecutive failures rather than retrying at a fixed rate', async () => {
    const { sd, attempts } = makeFailingDispatcher({ failures: 10 });

    sd.push(batch(active('a', '01A')));
    await settle();
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * 10);

    // Fixed-rate retry would have made 11 attempts in this window; 100 + 200 + 400 + 800 > 1000.
    expect(attempts.length).toBe(4);
  });

  it('caps the backoff so a long outage is still retried periodically', async () => {
    const { sd, attempts } = makeFailingDispatcher({ failures: 1_000 });

    sd.push(batch(active('a', '01A')));
    await settle();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const attemptsAfterTenMinutes = attempts.length;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(attempts.length).toBeGreaterThan(attemptsAfterTenMinutes);
  });

  it('resets the backoff after a successful delivery', async () => {
    const { sd, attempts } = makeFailingDispatcher({ failures: 3 });
    sd.push(batch(active('a', '01A')));
    await settle();
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * 7); // 100 + 200 + 400 → 4th attempt succeeds
    expect(attempts.length).toBe(4);

    // Next failure (none configured now) is irrelevant; a fresh push goes straight out.
    sd.push(batch(active('b', '01B')));
    await settle();

    expect(attempts.map(sentIds).at(-1)).toEqual(['b']);
  });

  it('stops retrying once paused (e.g. the client disconnected and its sync was closed)', async () => {
    const { sd, attempts } = makeFailingDispatcher({ failures: 1_000 });
    sd.push(batch(active('a', '01A')));
    await settle();

    sd.pause();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(attempts.length).toBe(1);
  });

  it('does not treat undelivered records as acknowledged', async () => {
    const { sd, attempts } = makeFailingDispatcher({ failures: 1 });

    sd.push(batch(active('a', '01A')));
    await settle();
    // Same record/version again: if the failed dispatch had been recorded as acknowledged,
    // the dispatcher would consider the client up to date and skip it.
    sd.push(batch(active('a', '01A')));
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);

    expect(attempts.map(sentIds).at(-1)).toEqual(['a']);
  });
});
