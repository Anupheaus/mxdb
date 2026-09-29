import '@anupheaus/common';
import { DateTime } from 'luxon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freezeInDevelopment } from './freezeInDevelopment';

describe('freezeInDevelopment', () => {
  const originalMode = process.env.NODE_ENV;
  const delivered = () => ({ records: [{ id: 'a', name: 'Alpha', tags: ['x'], at: DateTime.fromISO('2026-09-29T10:00:00Z') }], total: 1 });

  afterEach(() => { process.env.NODE_ENV = originalMode; });

  it('makes a mutation of a delivered record throw in a development build', () => {
    process.env.NODE_ENV = 'development';
    const result = freezeInDevelopment(delivered());
    expect(() => { result.records[0]!.name = 'Changed'; }).toThrow(TypeError);
    expect(() => { result.records[0]!.tags.push('y'); }).toThrow(TypeError);
    expect(() => { result.records.push({ ...result.records[0]! }); }).toThrow(TypeError);
  });

  it('leaves the DateTimes inside usable — luxon caches what it works out on the instance', () => {
    process.env.NODE_ENV = 'development';
    const result = freezeInDevelopment(delivered());
    expect(result.records[0]!.at.weekNumber).toBeGreaterThan(0);
    expect(Object.isFrozen(result.records[0]!.at)).toBe(false);
  });

  it.each(['production', 'test'])('changes nothing outside a development build (%s)', mode => {
    process.env.NODE_ENV = mode;
    const result = freezeInDevelopment(delivered());
    result.records[0]!.name = 'Changed';
    expect(result.records[0]!.name).toBe('Changed');
  });

  it('never walks into a record frozen before — the freeze is deep, so unchanged records cost nothing', () => {
    process.env.NODE_ENV = 'development';
    const record = freezeInDevelopment({ id: 'a', tags: ['x'] });
    const entries = vi.spyOn(Object, 'values');

    freezeInDevelopment({ records: [record, record], total: 2 });

    // The new result object and its array are walked; the already-frozen record is not
    expect(entries.mock.calls.map(([walked]) => walked)).not.toContain(record);
    entries.mockRestore();
  });

  it('copes with a value that refers to itself', () => {
    process.env.NODE_ENV = 'development';
    const looped: { self?: unknown } = {};
    looped.self = looped;
    expect(Object.isFrozen(freezeInDevelopment(looped))).toBe(true);
  });
});
