import { describe, it, expect, afterEach } from 'vitest';
import { getSlowQueryThresholdMs, SLOW_QUERY_THRESHOLD_ENV } from './slowQueryThreshold';

const DEFAULT_MS = 3_000;

describe('getSlowQueryThresholdMs', () => {
  afterEach(() => { delete process.env[SLOW_QUERY_THRESHOLD_ENV]; });

  it('defaults to 3 seconds', () => {
    expect(getSlowQueryThresholdMs()).toBe(DEFAULT_MS);
  });

  it('is configurable through the environment', () => {
    process.env[SLOW_QUERY_THRESHOLD_ENV] = '750';
    expect(getSlowQueryThresholdMs()).toBe(750);
  });

  it.each(['abc', '0', '-5', ''])('falls back to the default for "%s"', configured => {
    process.env[SLOW_QUERY_THRESHOLD_ENV] = configured;
    expect(getSlowQueryThresholdMs()).toBe(DEFAULT_MS);
  });
});
