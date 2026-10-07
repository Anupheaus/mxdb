import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import type { DataFilters } from '@anupheaus/common';
import { normaliseFilterConditions } from './normaliseFilterConditions';

// Vision sc-2518: a condition whose value is missing (`{ leadId: undefined }`) used to be dropped, so a screen with a
// missing key read every record in the collection. It now means "the field is missing", written as `null` — the value
// every query engine (SQLite, sift, MongoDB) reads as "null or missing", and which survives the JSON trip to the server.
// Any node it cannot read makes the WHOLE query match nothing (`{ id: { $in: [] } }`), wherever it sits. What each
// engine then returns is pinned by filterOperandCases.fixture.ts and filterFuzzCases.fixture.ts on device and server.

type Loose = DataFilters<{ [key: string]: unknown }>;
const normalise = (filters: Loose | undefined) => normaliseFilterConditions(filters);
const MATCH_NOTHING = { id: { $in: [] } };

describe('normaliseFilterConditions', () => {
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

  it.each([
    ['$in with no list', { $in: undefined }], ['$in with null', { $in: null }], ['$in with a value, not a list', { $in: 'a' }],
    ['$nin with no list', { $nin: undefined }], ['$ni with no list', { $ni: undefined }],
    ['$all with no list', { $all: undefined }], ['$all with an empty list', { $all: [] }],
    ['$eq with no value', { $eq: undefined }], ['$ne with null', { $ne: null }],
    ['$gte with no value', { $gte: undefined }], ['$lt with an object', { $lt: { at: 1 } }],
    ['$exists without a boolean', { $exists: 'yes' }], ['$size without a number', { $size: '1' }],
    ['$regex without a pattern', { $regex: 5 }], ['$like with no value', { $like: undefined }],
    ['$elemMatch without a filter', { $elemMatch: 'x' }], ['$elemMatch with an empty filter', { $elemMatch: {} }],
    ['$elemMatch over a broken operator', { $elemMatch: { $in: undefined } }], ['$not with no operand', { $not: undefined }],
    ['$not with nothing to negate', { $not: {} }], ['$not over a broken operator', { $not: { $in: undefined } }],
    ['an operator MXDB does not know', { $bogus: 1 }], ['an empty condition', {}], ['an empty nested path', { sub: {} }],
    ['operators and fields mixed', { $eq: 'a', sub: 1 }], ['a NaN bound', { $gt: Number.NaN }], ['a negative size', { $size: -1 }],
  ])('makes the whole query match nothing for %s — never drops it', (_label, condition) => {
    expect(normalise({ name: 'kept?', category: condition })).toEqual(MATCH_NOTHING);
  });

  it.each([
    ['a $or branch', { $or: [{ category: { $in: undefined } }, { name: 'Two' }] }],
    ['a $nor branch', { $nor: [{ category: { $in: undefined } }] }],
    ['a nested $and', { $and: [{ name: 'One' }, { $or: [{ value: { $gt: undefined } }] }] }],
    ['an unknown top-level operator', { $where: 'true' }],
  ])('makes the whole query match nothing for a broken node in %s — nothing broken can be negated', (_label, filters) => {
    expect(normalise(filters as Loose)).toEqual(MATCH_NOTHING);
  });

  it('fails closed even beside a sound operator', () => {
    expect(normalise({ start: { $gte: undefined, $lt: 5 } })).toEqual(MATCH_NOTHING);
  });

  it('keeps sound $not, $nor and $elemMatch, and an empty branch as "no condition"', () => {
    const filters = { a: { $not: { $gt: 5 } }, $nor: [{ b: 1 }], c: { $elemMatch: { $eq: 'x' } }, d: { $elemMatch: { e: undefined } }, $and: [{}] };
    expect(normalise(filters as Loose)).toEqual({ a: { $not: { $gt: 5 } }, $nor: [{ b: 1 }], c: { $elemMatch: { $eq: 'x' } }, d: { $elemMatch: { e: null } }, $and: [{}] });
  });

  it('keeps a sound list, and an empty $in / $nin (which already mean "nothing" / "anything")', () => {
    expect(normalise({ a: { $in: ['x'] }, b: { $in: [] }, c: { $nin: [] } })).toEqual({ a: { $in: ['x'] }, b: { $in: [] }, c: { $nin: [] } });
  });

  it.each([
    ['missing', undefined], ['null', null], ['empty', []], ['not a list', 'x'], ['not a list of filters', ['x']],
  ])('makes a $or / $and / $nor whose branches are %s match nothing', (_label, branches) => {
    for (const operator of ['$or', '$and', '$nor']) {
      expect(normalise({ [operator]: branches } as Loose)).toEqual(MATCH_NOTHING);
    }
  });

  it('survives the JSON trip to the server: a broken list is still "nothing", not `{}`', () => {
    expect(JSON.parse(JSON.stringify(normalise({ category: { $in: undefined } })))).toEqual(MATCH_NOTHING);
  });

  it('turns a missing value in a list into "missing" (bare array, $in, $nin, $all)', () => {
    expect(normalise({ id: ['a', undefined], leadId: { $in: [undefined] }, tag: { $nin: [undefined, 'x'] }, tags: { $all: [undefined] } }))
      .toEqual({ id: ['a', null], leadId: { $in: [null] }, tag: { $nin: [null, 'x'] }, tags: { $all: [null] } });
  });

  it('normalises an $elemMatch sub-filter as a filter of its own', () => {
    expect(normalise({ items: { $elemMatch: { productId: undefined } } })).toEqual({ items: { $elemMatch: { productId: null } } });
  });

  it('leaves dates and DateTimes as values, and spells a bare pattern out as $regex', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const dateTime = DateTime.fromISO('2026-01-01T00:00:00Z');
    const pattern = /derby/i;
    const result = normalise({ a: date, b: dateTime, c: pattern, d: { $gt: dateTime } }) as { [key: string]: unknown };
    expect(result.a).toBe(date);
    expect(result.b).toBe(dateTime);
    expect(result.c).toEqual({ $regex: pattern });
    expect((result.d as { $gt: DateTime }).$gt).toBe(dateTime);
  });

  it('never changes the filters it was given', () => {
    const filters = { leadId: undefined, $or: [{ addressId: undefined }] };
    normalise(filters);
    expect(filters).toEqual({ leadId: undefined, $or: [{ addressId: undefined }] });
    expect('leadId' in filters).toBe(true);
  });
});
