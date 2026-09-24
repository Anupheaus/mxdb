/**
 * How the {@link ClientDispatcher} retries a record the server keeps failing to write (it answers without
 * acknowledging it, or the dispatch itself keeps throwing). The first few retries run at the dispatcher's
 * normal interval — they absorb transient blips such as a reconnect or a slow response — then the delay
 * doubles from {@link SYNC_RETRY_BASE_DELAY_MS} up to {@link SYNC_RETRY_MAX_DELAY_MS}. A record is never
 * dropped: after {@link SYNC_ATTEMPTS_BEFORE_STALLED} attempts it is reported as stalled and keeps retrying.
 */

/** Consecutive failed attempts retried at the dispatcher's normal interval before backing off. */
export const SYNC_FAST_RETRY_ATTEMPTS = 3;

/** The first backed-off delay (ms); it doubles with each further failed attempt. */
export const SYNC_RETRY_BASE_DELAY_MS = 1_000;

/** The longest delay (ms) between attempts, however many have failed. */
export const SYNC_RETRY_MAX_DELAY_MS = 60_000;

/** After this many consecutive failed attempts the record is reported as stalled (once; it keeps retrying). */
export const SYNC_ATTEMPTS_BEFORE_STALLED = 5;

export interface SyncRetryDelayProps {
  /** Consecutive failed attempts so far (1 after the first failure). */
  attempts: number;
  /** The dispatcher's normal interval (ms). */
  intervalMs: number;
}

/** The delay (ms) before the next attempt after `attempts` consecutive failures. */
export function syncRetryDelayMs({ attempts, intervalMs }: SyncRetryDelayProps): number {
  if (attempts <= SYNC_FAST_RETRY_ATTEMPTS) return intervalMs;
  return Math.min(SYNC_RETRY_MAX_DELAY_MS, SYNC_RETRY_BASE_DELAY_MS * 2 ** (attempts - SYNC_FAST_RETRY_ATTEMPTS - 1));
}
