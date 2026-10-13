import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import type { DataFilters } from '@anupheaus/common';
import { createFilterMatcher } from './createFilterMatcher';
import { normaliseFilterConditions } from './normaliseFilterConditions';

// Vision sc-2518: the device's evaluator follows MongoDB's path and comparison rules. These pin the rules one by one;
// ServerDbCollection.differential.tests.ts checks them against MongoDB itself.

type Loose = DataFilters<{ [key: string]: unknown }>;
const matches = (record: object, filters: Loose) => createFilterMatcher(normaliseFilterConditions(filters))(record);

describe('createFilterMatcher', () => {
  it.each([
    ['a list of plain values mid-path is skipped, not "missing"', { list: [1, 2] }, { 'list.id': null }, false],
    ['a list of text mid-path is skipped', { list: ['z'] }, { 'list.id': undefined }, false],
    ['an object in a list without the field is "missing"', { list: [1, {}] }, { 'list.id': null }, true],
    ['an empty list mid-path is not "missing"', { list: [] }, { 'list.id': null }, false],
    ['a list of lists mid-path is skipped', { nest: [[{ k: 1 }], [1, 2]] }, { 'nest.k': null }, false],
    ['a list of lists is not walked into', { nest: [[{ k: 1 }]] }, { 'nest.k': 1 }, false],
    ['a list inside an element mid-path is skipped', { nest: [{ k: [1, 2] }] }, { 'nest.k.m': null }, false],
    ['$nin through skipped elements matches', { mix: [2, 3] }, { 'mix.k': { $exists: false, $nin: [0, null] } }, true],
    ['a plain value mid-path, outside a list, is "missing"', { address: 'flat' }, { 'address.city': null }, true],
    ['a list at the end is matched by its elements', { tags: ['x', 'y'] }, { tags: 'y' }, true],
    ['but not by the elements of a list inside it', { tags: [['x']] }, { tags: 'x' }, false],
    ['types never mix', { value: '5' }, { value: 5 }, false],
    ['$ne counts a missing field as "not"', {}, { value: { $ne: 5 } }, true],
    ['text orders by code point', { name: '\u{1F600}' }, { name: { $gt: '￿' } }, true],
  ])('%s', (_label, record, filters, expected) => {
    expect(matches(record, filters as Loose)).toBe(expected);
  });

  it('compares a Date, a DateTime and ISO date-time text in a filter as the same instant', () => {
    const record = { when: DateTime.fromISO('2026-01-01T00:00:00Z') };
    expect(matches(record, { when: '2026-01-01T00:00:00.000Z' })).toBe(true);
    expect(matches(record, { when: new Date('2026-01-01T00:00:00Z') })).toBe(true);
    expect(matches(record, { when: { $in: ['2026-01-01T01:00:00+01:00'] } })).toBe(true);
    expect(matches(record, { when: { $gt: '2025-12-31T23:59:59Z' } })).toBe(true);
    expect(matches({ when: '2026-01-01T00:00:00.000Z' }, { when: '2026-01-01T00:00:00.000Z' })).toBe(false); // a text field is text
  });

  it('reads a large $in list once per query, not once per record', () => {
    const records = Array.from({ length: 20_000 }, (_, index) => ({ id: `id-${index * 3}` }));
    const timeWith = (ids: string[]) => {
      const matcher = createFilterMatcher(normaliseFilterConditions({ id: { $in: ids } }));
      const started = performance.now();
      const count = records.filter(matcher).length;
      return { milliseconds: performance.now() - started, count };
    };
    timeWith(['warm-up']);
    const short = timeWith(['id-3']);
    const long = timeWith(Array.from({ length: 50_000 }, (_, index) => `id-${index}`));
    expect([short.count, long.count]).toEqual([1, 16_667]);
    // Read per record, a 50,000-id list would cost thousands of times the one-id list; as a set it costs about the same.
    expect(long.milliseconds).toBeLessThan(Math.max(short.milliseconds * 10, 50));
  });
});
