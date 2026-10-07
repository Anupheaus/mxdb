import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import type { DataFilters } from '@anupheaus/common';
import { matchMissingForEmptyValues } from './matchMissingForEmptyValues';

// Vision sc-2518: a condition whose value is missing (`{ leadId: undefined }`) used to be dropped, so a screen with a
// missing key read every record in the collection. It now means "the field is missing", written as `null` — the value
// every query engine (SQLite, sift, MongoDB) reads as "null or missing", and which survives the JSON trip to the server.

type Loose = DataFilters<{ [key: string]: unknown }>;
const normalise = (filters: Loose | undefined) => matchMissingForEmptyValues(filters);

describe('matchMissingForEmptyValues', () => {
  it('leaves "no filter" alone: undefined, and an empty object, still read everything', () => {
    expect(normalise(undefined)).toBeUndefined();
    expect(normalise({})).toEqual({});
  });

  it('turns a field condition with no value into "the field is missing"', () => {
    expect(normalise({ leadId: undefined, cancelledAt: null })).toEqual({ leadId: null, cancelledAt: null });
  });

  it('keeps the key, so the condition is still there after a JSON round trip to the server', () => {
    const sent = JSON.parse(JSON.stringify(normalise({ addressId: undefined })));
    expect(sent).toEqual({ addressId: null });
  });

  it('does the same on a nested field path', () => {
    expect(normalise({ address: { id: undefined, city: 'Derby' } })).toEqual({ address: { id: null, city: 'Derby' } });
  });

  it('does the same inside $or / $and / $nor branches', () => {
    expect(normalise({ $or: [{ leadId: undefined }, { contactId: 'c1' }], $and: [{ addressId: undefined }], $nor: [{ x: undefined }] }))
      .toEqual({ $or: [{ leadId: null }, { contactId: 'c1' }], $and: [{ addressId: null }], $nor: [{ x: null }] });
  });

  it('treats $eq / $ne with no value as "missing" / "present"', () => {
    expect(normalise({ leadId: { $eq: undefined }, addressId: { $ne: undefined } })).toEqual({ leadId: { $eq: null }, addressId: { $ne: null } });
  });

  it('turns a missing value in a list into "missing" (bare array, $in, $nin, $all)', () => {
    expect(normalise({ id: ['a', undefined], leadId: { $in: [undefined] }, tag: { $nin: [undefined, 'x'] }, tags: { $all: [undefined] } }))
      .toEqual({ id: ['a', null], leadId: { $in: [null] }, tag: { $nin: [null, 'x'] }, tags: { $all: [null] } });
  });

  it('normalises an $elemMatch sub-filter as a filter of its own', () => {
    expect(normalise({ items: { $elemMatch: { productId: undefined } } })).toEqual({ items: { $elemMatch: { productId: null } } });
  });

  it('leaves an unset range or text bound out, as before: it narrows nothing, it is not a key', () => {
    // A field left with no bound at all is dropped, rather than sent as `{}` (which MongoDB reads as "equals {}").
    const result = normalise({ start: { $gte: undefined, $lt: 5 }, name: { $like: undefined } });
    expect(result).toEqual({ start: { $lt: 5 } });
    expect(Object.keys(result ?? {})).toEqual(['start']);
  });

  it('leaves dates, DateTimes and regexes as values, not as nested conditions', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const dateTime = DateTime.fromISO('2026-01-01T00:00:00Z');
    const pattern = /derby/i;
    const result = normalise({ a: date, b: dateTime, c: pattern, d: { $gt: dateTime } }) as { [key: string]: unknown };
    expect(result.a).toBe(date);
    expect(result.b).toBe(dateTime);
    expect(result.c).toBe(pattern);
    expect((result.d as { $gt: DateTime }).$gt).toBe(dateTime);
  });

  it('never changes the filters it was given', () => {
    const filters = { leadId: undefined, $or: [{ addressId: undefined }] };
    normalise(filters);
    expect(filters).toEqual({ leadId: undefined, $or: [{ addressId: undefined }] });
    expect('leadId' in filters).toBe(true);
  });
});
