import { describe, it, expect, afterEach } from 'vitest';
import { decodeTime, isValid as isValidUlid, monotonicFactory } from 'ulidx';
import { generateUlid, generateUlidAfter, setClockDrift } from './time';

// Reset clock drift after each test so tests don't interfere with each other
afterEach(() => {
  setClockDrift(0);
});

describe('generateUlid', () => {
  it('returns a 26-character ULID string', () => {
    const id = generateUlid();
    expect(typeof id).toBe('string');
    expect(id).toHaveLength(26);
  });

  it('returns a valid ULID (parseable by ulidx)', () => {
    const id = generateUlid();
    expect(isValidUlid(id)).toBe(true);
  });

  it('generates monotonically increasing ULIDs in rapid succession', () => {
    const ids = Array.from({ length: 10 }, () => generateUlid());
    for (let i = 1; i < ids.length; i++) {
      // Lexicographic order == temporal order for ULIDs
      expect(ids[i]! >= ids[i - 1]!).toBe(true);
    }
  });

  it('same-ms monotonic ULIDs share an 8-char prefix — do not truncate entry ids in logs', () => {
    const m = monotonicFactory();
    const t = Date.now();
    const a = m(t);
    const b = m(t);
    expect(a).not.toBe(b);
    expect(a.slice(0, 8)).toBe(b.slice(0, 8));
  });

  it('encodes a timestamp close to Date.now()', () => {
    const before = Date.now();
    const id = generateUlid();
    const after = Date.now();
    const ts = decodeTime(id);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 1); // +1ms tolerance for monotonic bump
  });
});

describe('setClockDrift', () => {
  it('positive drift shifts ULID timestamps earlier (client is behind server)', () => {
    // With zero drift, ULIDs encode ~Date.now()
    const id0 = generateUlid();
    const t0 = decodeTime(id0);

    // Positive drift = server is ahead by 5s; client subtracts drift from Date.now()
    setClockDrift(5_000);
    const id1 = generateUlid();
    const t1 = decodeTime(id1);

    expect(t1).toBeLessThan(t0 + 100); // should be noticeably earlier
  });

  it('negative drift shifts ULID timestamps later (client is ahead of server)', () => {
    const id0 = generateUlid();
    const t0 = decodeTime(id0);

    setClockDrift(-5_000);
    const id1 = generateUlid();
    const t1 = decodeTime(id1);

    expect(t1).toBeGreaterThan(t0);
  });

  it('resets the monotonic factory (new sequence starts)', () => {
    // Generate a ULID, then reset drift - should still produce valid ULIDs
    generateUlid();
    setClockDrift(0);
    const id = generateUlid();
    expect(isValidUlid(id)).toBe(true);
  });

  it('zero drift produces timestamps matching Date.now()', () => {
    setClockDrift(0);
    const before = Date.now();
    const id = generateUlid();
    const after = Date.now();
    const ts = decodeTime(id);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 1);
  });

  it('subsequent calls to generateUlid after setClockDrift remain monotonic', () => {
    setClockDrift(1_000);
    const ids = Array.from({ length: 5 }, () => generateUlid());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! >= ids[i - 1]!).toBe(true);
    }
  });
});

describe('generateUlidAfter', () => {
  const HOUR_MS = 3_600_000;
  const ulidAt = (timeMs: number): string => monotonicFactory()(timeMs);

  const latestIds: Array<[string, () => string | undefined]> = [
    ['there is no latest id', () => undefined],
    ['the latest id is in the past', () => ulidAt(Date.now() - HOUR_MS)],
    ['the latest id is from a clock an hour ahead', () => ulidAt(Date.now() + HOUR_MS)],
    ['the latest id is from a clock a year ahead', () => ulidAt(Date.now() + 365 * 24 * HOUR_MS)],
  ];

  it.each(latestIds)('returns a valid ULID when %s', (_label, latestId) => {
    expect(isValidUlid(generateUlidAfter(latestId()))).toBe(true);
  });

  it.each(latestIds.slice(1))('sorts after the latest id when %s', (_label, latestId) => {
    const latest = latestId()!;

    expect(generateUlidAfter(latest) > latest).toBe(true);
  });

  it('sorts after a latest id from a skewed clock even while this clock is also skewed', () => {
    setClockDrift(HOUR_MS);
    const latest = ulidAt(Date.now() + HOUR_MS);

    expect(generateUlidAfter(latest) > latest).toBe(true);
  });

  it('uses the current time when the latest id is in the past', () => {
    const before = Date.now();

    const ts = decodeTime(generateUlidAfter(ulidAt(before - HOUR_MS)));

    expect(ts).toBeGreaterThanOrEqual(before);
  });
});
