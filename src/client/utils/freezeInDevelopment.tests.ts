import '@anupheaus/common';
import { DateTime } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
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

  it('copes with a value that refers to itself', () => {
    process.env.NODE_ENV = 'development';
    const looped: { self?: unknown } = {};
    looped.self = looped;
    expect(Object.isFrozen(freezeInDevelopment(looped))).toBe(true);
  });
});
