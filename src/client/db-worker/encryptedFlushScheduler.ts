/**
 * Coalesces the persisting of an encrypted in-memory database (sc-680).
 *
 * Persisting means exporting the WHOLE database and encrypting it (see `flushEncrypted`), which costs several times
 * the database's size in memory. Doing it after every write — and letting bursts of writes run several at once —
 * exhausted the worker's memory ("Array buffer allocation failed"). Instead a write only marks the database dirty, and
 * ONE flush runs at a time: debounced to {@link EncryptedFlushSchedulerProps.debounceMs} after the last write, but at
 * most {@link EncryptedFlushSchedulerProps.maxWaitMs} after the first unflushed one under constant writes.
 *
 * The cost: the latest writes live only in memory until the next flush (at most `maxWaitMs`, plus a flush on close and
 * when a tab is hidden). That is acceptable because the server is the source of truth and the client re-syncs.
 */

/** Default quiet period after the last write before a flush. */
export const FLUSH_DEBOUNCE_MS = 1_000;
/** Default longest a write waits for a flush while writes keep arriving. */
export const FLUSH_MAX_WAIT_MS = 5_000;

export interface EncryptedFlushSchedulerProps {
  /** Persists the database as it is now. May throw; a failure is reported and retried. */
  flush(): Promise<void>;
  /** Reports a failed flush. The database stays dirty and the flush is retried; the in-memory data is untouched. */
  onFlushFailed(error: unknown): void;
  debounceMs?: number;
  maxWaitMs?: number;
}

export interface EncryptedFlushScheduler {
  /** A write happened: schedule a flush (coalesced with any other pending one). */
  markDirty(): void;
  /** Flush now if anything is unflushed, after any flush in flight — for close, a database switch or a hidden tab. */
  flushNow(): Promise<void>;
  /** Forget pending work (after the database is closed). */
  reset(): void;
}

export function createEncryptedFlushScheduler({
  flush, onFlushFailed, debounceMs = FLUSH_DEBOUNCE_MS, maxWaitMs = FLUSH_MAX_WAIT_MS,
}: EncryptedFlushSchedulerProps): EncryptedFlushScheduler {
  let isDirty = false;
  /** When the oldest unflushed write happened (epoch ms), bounding the debounce under constant writes. */
  let dirtySince: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  function clearTimer(): void {
    if (timer == null) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function schedule(): void {
    clearTimer();
    const untilMaxWait = (dirtySince ?? Date.now()) + maxWaitMs - Date.now();
    timer = setTimeout(onTimer, Math.max(0, Math.min(debounceMs, untilMaxWait)));
  }

  function onTimer(): void {
    timer = undefined;
    // One flush at a time: the one in flight reschedules when it finishes if more writes arrived meanwhile.
    if (inFlight != null) return;
    void flushOnce();
  }

  function flushOnce(): Promise<void> {
    isDirty = false;
    dirtySince = undefined;
    inFlight = (async () => {
      try {
        await flush();
      } catch (error) {
        // Still unflushed: keep it dirty so the next flush retries it.
        isDirty = true;
        dirtySince ??= Date.now();
        onFlushFailed(error);
      } finally {
        inFlight = undefined;
        if (isDirty && timer == null) schedule();
      }
    })();
    return inFlight;
  }

  function markDirty(): void {
    isDirty = true;
    dirtySince ??= Date.now();
    schedule();
  }

  async function flushNow(): Promise<void> {
    clearTimer();
    while (inFlight != null) await inFlight;
    if (isDirty) await flushOnce();
  }

  function reset(): void {
    clearTimer();
    isDirty = false;
    dirtySince = undefined;
  }

  return { markDirty, flushNow, reset };
}
