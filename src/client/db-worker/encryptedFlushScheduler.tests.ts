import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEncryptedFlushScheduler, FLUSH_DEBOUNCE_MS, FLUSH_MAX_WAIT_MS } from './encryptedFlushScheduler';

/**
 * sc-680: persisting the encrypted database exports and encrypts the whole of it, so writes must not each trigger one,
 * and two must never run at once. A failed flush is reported and retried, never thrown.
 */

interface Harness {
  flush: ReturnType<typeof vi.fn<() => Promise<void>>>;
  onFlushFailed: ReturnType<typeof vi.fn<(error: unknown) => void>>;
  scheduler: ReturnType<typeof createEncryptedFlushScheduler>;
  /** How many flushes are running right now, and the most that ever ran at once. */
  concurrency: { now: number; max: number };
}

function createHarness(flushImpl: () => Promise<void> = async () => void 0): Harness {
  const concurrency = { now: 0, max: 0 };
  const flush = vi.fn(async () => {
    concurrency.now++;
    concurrency.max = Math.max(concurrency.max, concurrency.now);
    try { await flushImpl(); } finally { concurrency.now--; }
  });
  const onFlushFailed = vi.fn();
  return { flush, onFlushFailed, scheduler: createEncryptedFlushScheduler({ flush, onFlushFailed }), concurrency };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('createEncryptedFlushScheduler', () => {
  it('coalesces a burst of writes into one flush, a moment after the last', async () => {
    const { scheduler, flush } = createHarness();
    for (let write = 0; write < 500; write++) scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS - 1);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledOnce();
  });

  it('still flushes under constant writes, at most every max-wait', async () => {
    const { scheduler, flush } = createHarness();
    for (let elapsed = 0; elapsed < FLUSH_MAX_WAIT_MS * 3; elapsed += 200) {
      scheduler.markDirty();
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(flush).toHaveBeenCalledTimes(3);
  });

  it('never runs two flushes at once, and catches up once the one in flight finishes', async () => {
    let finishFlush!: () => void;
    const { scheduler, flush, concurrency } = createHarness(() => new Promise<void>(resolve => { finishFlush = resolve; }));
    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(flush).toHaveBeenCalledOnce();

    // Writes keep arriving while the first flush is still running.
    for (let write = 0; write < 10; write++) {
      scheduler.markDirty();
      await vi.advanceTimersByTimeAsync(FLUSH_MAX_WAIT_MS);
    }
    expect(flush).toHaveBeenCalledOnce();

    finishFlush();
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(flush).toHaveBeenCalledTimes(2);
    finishFlush();
    await vi.advanceTimersByTimeAsync(FLUSH_MAX_WAIT_MS);
    expect(concurrency.max).toBe(1);
  });

  it('reports a failed flush and retries it — it never throws', async () => {
    const error = new Error('Array buffer allocation failed');
    let isFailing = true;
    const { scheduler, flush, onFlushFailed } = createHarness(async () => { if (isFailing) throw error; });
    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(onFlushFailed).toHaveBeenCalledWith(error);

    isFailing = false;
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(onFlushFailed).toHaveBeenCalledOnce();
  });

  it('flushes now on request (close, a hidden tab), after any flush in flight', async () => {
    let finishFlush!: () => void;
    const { scheduler, flush, concurrency } = createHarness(() => new Promise<void>(resolve => { finishFlush = resolve; }));
    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    scheduler.markDirty();

    const flushed = scheduler.flushNow();
    finishFlush();
    await vi.advanceTimersByTimeAsync(0);
    finishFlush();
    await flushed;
    expect(flush).toHaveBeenCalledTimes(2);
    expect(concurrency.max).toBe(1);
  });

  it('does not flush on request when nothing has changed, nor after a reset', async () => {
    const { scheduler, flush } = createHarness();
    await scheduler.flushNow();
    scheduler.markDirty();
    scheduler.reset();
    await vi.advanceTimersByTimeAsync(FLUSH_MAX_WAIT_MS);
    await scheduler.flushNow();
    expect(flush).not.toHaveBeenCalled();
  });
});
