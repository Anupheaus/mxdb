import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDbReadyWaitHandle } from './dbReadyWait';

describe('createDbReadyWaitHandle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves true immediately when already ready', async () => {
    const handle = createDbReadyWaitHandle(3_000);
    handle.setIsDbReady(true);
    await expect(handle.waitForDbReady()).resolves.toBe(true);
  });

  it('resolves true when readiness is set while waiting', async () => {
    const handle = createDbReadyWaitHandle(3_000);
    const pending = handle.waitForDbReady();
    handle.setIsDbReady(true);
    await expect(pending).resolves.toBe(true);
  });

  it('resolves false after timeout when never ready', async () => {
    const handle = createDbReadyWaitHandle(1_000);
    const pending = handle.waitForDbReady();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(false);
  });

  it('getIsDbReady reflects the latest setIsDbReady value', () => {
    const handle = createDbReadyWaitHandle(1_000);
    expect(handle.getIsDbReady()).toBe(false);
    handle.setIsDbReady(true);
    expect(handle.getIsDbReady()).toBe(true);
  });
});
