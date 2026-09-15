// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import type { Record } from '@anupheaus/common';
import { distinctRecordsInMemory, queryRecordsInMemory } from './queryRecordsInMemory';

interface Widget extends Record {
  id: string;
  name: string;
  size: number;
  tags?: string[];
  city?: string | null;
  start?: DateTime;
  nested?: { level: number };
}

function makeWidgets(): Widget[] {
  return [
    { id: 'a', name: 'Alpha', size: 10, tags: ['red', 'small'], city: 'London', start: DateTime.fromISO('2026-01-01T00:00:00Z'), nested: { level: 1 } },
    { id: 'b', name: 'Beta', size: 20, tags: ['blue'], city: 'Paris', start: DateTime.fromISO('2026-02-01T00:00:00Z'), nested: { level: 2 } },
    { id: 'c', name: 'Gamma', size: 30, tags: ['red', 'large'], city: null, start: DateTime.fromISO('2026-03-01T00:00:00Z'), nested: { level: 3 } },
    { id: 'd', name: 'Delta', size: 20, tags: [], city: 'London', start: DateTime.fromISO('2026-04-01T00:00:00Z'), nested: { level: 2 } },
  ];
}

const idsOf = (records: Widget[] | null): string[] | null => records == null ? null : records.map(r => r.id);

describe('queryRecordsInMemory', () => {
  it('returns all records with no filter, total = count', () => {
    const result = queryRecordsInMemory(makeWidgets(), {});
    expect(result).not.toBeNull();
    expect(idsOf(result!.records)).toEqual(['a', 'b', 'c', 'd']);
    expect(result!.total).toBe(4);
  });

  it('matches direct field equality', () => {
    const result = queryRecordsInMemory(makeWidgets(), { filters: { size: 20 } });
    expect(idsOf(result!.records)).toEqual(['b', 'd']);
  });

  it('treats a bare array value as $in (not array-equality)', () => {
    const result = queryRecordsInMemory(makeWidgets(), { filters: { id: ['a', 'c'] } as never });
    expect(idsOf(result!.records)).toEqual(['a', 'c']);
  });

  it('matches $in', () => {
    const result = queryRecordsInMemory(makeWidgets(), { filters: { size: { $in: [10, 30] } } });
    expect(idsOf(result!.records)).toEqual(['a', 'c']);
  });

  it('matches numeric comparison operators', () => {
    const result = queryRecordsInMemory(makeWidgets(), { filters: { size: { $gte: 20, $lt: 30 } } });
    expect(idsOf(result!.records)).toEqual(['b', 'd']);
  });

  it('matches null via direct equality (city is null)', () => {
    const result = queryRecordsInMemory(makeWidgets(), { filters: { city: null } });
    expect(idsOf(result!.records)).toEqual(['c']);
  });

  it('matches nested field paths', () => {
    const result = queryRecordsInMemory(makeWidgets(), { filters: { nested: { level: 2 } } });
    expect(idsOf(result!.records)).toEqual(['b', 'd']);
  });

  it('matches $or', () => {
    const result = queryRecordsInMemory(makeWidgets(), { filters: { $or: [{ size: 10 }, { city: 'Paris' }] } });
    expect(idsOf(result!.records)).toEqual(['a', 'b']);
  });

  it('compares DateTime fields with $gt (normalised to Date for sift)', () => {
    const result = queryRecordsInMemory(makeWidgets(), { filters: { start: { $gt: DateTime.fromISO('2026-02-15T00:00:00Z') } } });
    expect(idsOf(result!.records)).toEqual(['c', 'd']);
  });

  it('matches DateTime equality by instant', () => {
    const result = queryRecordsInMemory(makeWidgets(), { filters: { start: DateTime.fromISO('2026-02-01T00:00:00Z') } });
    expect(idsOf(result!.records)).toEqual(['b']);
  });

  it('sorts ascending by a field', () => {
    const result = queryRecordsInMemory(makeWidgets(), { sorts: [['size', 'asc']] });
    expect(idsOf(result!.records)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('sorts descending by a field', () => {
    const result = queryRecordsInMemory(makeWidgets(), { sorts: [['size', 'desc']] });
    expect(idsOf(result!.records)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('sorts by DateTime field chronologically', () => {
    const result = queryRecordsInMemory(makeWidgets(), { sorts: [['start', 'desc']] });
    expect(idsOf(result!.records)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('paginates: total is the full match count, records is the page', () => {
    const result = queryRecordsInMemory(makeWidgets(), { sorts: [['size', 'asc']], pagination: { limit: 2, offset: 1 } });
    expect(idsOf(result!.records)).toEqual(['b', 'd']);
    expect(result!.total).toBe(4);
  });

  it('applies filter, then sort, then pagination together', () => {
    const result = queryRecordsInMemory(makeWidgets(), {
      filters: { size: { $gte: 20 } },
      sorts: [['name', 'asc']],
      pagination: { limit: 1, offset: 0 },
    });
    expect(idsOf(result!.records)).toEqual(['b']); // Beta, Delta, Gamma → first is Beta
    expect(result!.total).toBe(3);
  });

  // SQL's 3-valued NULL logic excludes null/missing rows from negative matches, whereas sift's 2-valued logic
  // includes them — so these operators can't be evaluated in-memory with guaranteed parity and must fall back
  // to the worker. String/array/regex operators are likewise deferred to the worker for v1.
  const unsupportedFilters: Array<[string, { [key: string]: unknown }]> = [
    ['$ne', { size: { $ne: 20 } }],
    ['$nin', { size: { $nin: [20] } }],
    ['$ni', { size: { $ni: [20] } }],
    ['$exists', { start: { $exists: true } }],
    ['$elemMatch', { tags: { $elemMatch: { $eq: 'red' } } }],
    ['$regex', { name: { $regex: '^A' } }],
    ['$beginsWith', { name: { $beginsWith: 'A' } }],
    ['$all', { tags: { $all: ['red'] } }],
  ];

  it.each(unsupportedFilters)('returns null (falls back to worker) for unsupported operator %s', (_label, filters) => {
    const result = queryRecordsInMemory(makeWidgets(), { filters: filters as never });
    expect(result).toBeNull();
  });
});

describe('distinctRecordsInMemory', () => {
  it('returns distinct scalar values, collapsing null and missing, in first-seen order', () => {
    const result = distinctRecordsInMemory(makeWidgets(), { field: 'city' });
    expect(result).toEqual(['London', 'Paris', null]);
  });

  it('returns distinct numeric values', () => {
    const result = distinctRecordsInMemory(makeWidgets(), { field: 'size' });
    expect(result).toEqual([10, 20, 30]);
  });

  it('applies the filter before collecting distinct values', () => {
    const result = distinctRecordsInMemory(makeWidgets(), { field: 'city', filters: { size: 20 } });
    expect(result).toEqual(['Paris', 'London']); // b=Paris, d=London
  });

  it('sorts distinct values by the field ascending (NULLs first, like SQLite)', () => {
    const result = distinctRecordsInMemory(makeWidgets(), { field: 'city', sorts: [['city', 'asc']] });
    expect(result).toEqual([null, 'London', 'Paris']);
  });

  it('sorts distinct values by the field descending (NULLs last)', () => {
    const result = distinctRecordsInMemory(makeWidgets(), { field: 'city', sorts: [['city', 'desc']] });
    expect(result).toEqual(['Paris', 'London', null]);
  });

  it('returns null (falls back) for a non-scalar field (DateTime)', () => {
    const result = distinctRecordsInMemory(makeWidgets(), { field: 'start' });
    expect(result).toBeNull();
  });

  it('returns null (falls back) when sorted by a field other than the distinct field', () => {
    const result = distinctRecordsInMemory(makeWidgets(), { field: 'city', sorts: [['size', 'asc']] });
    expect(result).toBeNull();
  });

  it('returns null (falls back) for an unsupported filter', () => {
    const result = distinctRecordsInMemory(makeWidgets(), { field: 'city', filters: { size: { $ne: 20 } } as never });
    expect(result).toBeNull();
  });
});
