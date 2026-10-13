import type { DataFilters, Record } from '@anupheaus/common';
import { DateTime } from 'luxon';

// Test-only: random filters drawn from MXDB's whitelist grammar (isReadableFilter.ts), run against the same records on
// the device and on the server. Both must return exactly the same records (Vision sc-2518). The records cover every
// shape a field can take — text, numbers, booleans, dates, null, missing, lists of values, lists holding null, lists of
// objects, lists of lists, lists mixing values and objects, objects, a value of the "wrong" type — and the paths walk
// through all of them, so a filter the two engines read differently shows up.

export interface DifferentialRecord extends Record {
  name: string;
  [field: string]: unknown;
}

const day = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' });

export const DIFFERENTIAL_RECORDS: DifferentialRecord[] = [
  { id: 'd1', name: 'Alpha', category: 'a', value: 10, flag: true, tags: ['x', 'y'], address: { city: 'Derby', zip: 'DE1' }, items: [{ sku: 's1', qty: 2 }, { sku: 's2', qty: 5 }], when: day('2026-01-01') },
  { id: 'd2', name: 'Bravo', category: 'b', value: 20, flag: false, tags: ['x'], address: { city: 'Leeds' }, items: [{ sku: 's2', qty: 1 }], when: day('2026-02-01') },
  { id: 'd3', name: 'Charlie', category: '', value: 30.5, tags: [], address: { city: null }, items: [] },
  { id: 'd4', name: 'Delta', category: null, value: -5, flag: true, tags: ['z', null], when: day('2026-03-01') },
  { id: 'd5', name: 'Echo' },
  { id: 'd6', name: 'Foxtrot\n', category: '5', value: '5', flag: 1, tags: 'x', address: 'not an object', items: [{ sku: 's1' }, { qty: 3 }] },
  { id: 'd7', name: 'Golf', category: 'A', value: 0, tags: ['y', 'x', 'x'], address: { city: 'derby', zip: 7 } },
  { id: 'd8', name: 'Échelle', category: 'ab', value: 1000, flag: false, items: [{ sku: null }] },
  // Paths through lists of plain values, lists of lists and lists mixing values and objects (QA round 6).
  { id: 'd9', name: 'Hotel', mix: [1, { k: 'v' }], nest: [[{ k: 1 }], [1, 2]], list: [1, 2], deep: { a: [{ b: 1 }, { b: [2, 3] }] } },
  { id: 'd10', name: 'India', mix: [2, 3], nest: [{ k: [1, 2] }], list: ['z'], deep: { a: [] }, when: day('2026-02-01T12:30:00') },
  { id: 'd11', name: 'Juliet', mix: [{ k: null }, {}], nest: [{ k: { m: 5 } }], list: [{ ref: 'd1' }], deep: { a: { b: null } } },
  { id: 'd12', name: 'Kilo', mix: [[{ k: 'v' }]], nest: [null, { k: 1 }], list: [null], items: [null, { sku: 's1' }] },
  { id: 'd13', name: 'Lima', tags: [['x'], 'y'], value: [10, 20], flag: null, items: [{ qty: [1, 5] }], deep: 'flat' },
  { id: 'd14', name: 'Mike', mix: { k: 'v' }, nest: [{ k: 'v' }, { k: [] }], list: [], value: [[10]], when: day('2025-12-31T23:59:59.999Z') },
];

const FIELDS = [
  'name', 'category', 'value', 'flag', 'tags', 'address.city', 'address.zip', 'items.sku', 'items.qty', 'when', 'id', 'missing',
  'mix', 'mix.k', 'nest', 'nest.k', 'nest.k.m', 'list', 'list.id', 'list.ref', 'deep.a', 'deep.a.b', 'missing.deeper',
] as const;

const VALUES: unknown[] = [
  'a', 'b', '', 'A', 'ab', 'x', 'y', 'z', '5', 'v', 'Derby', 'derby', 'DE1', 's1', 's2', 'Alpha', 'Foxtrot\n', 'Échelle', 'd1', 'd4', 'flat',
  0, 1, 2, 3, 5, 7, 10, 20, 30.5, -5, 1000, true, false,
  day('2026-01-01'), day('2026-02-15'), day('2026-03-01'), new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T12:30:00Z'),
  // ISO date-time text: an instant on both engines (QA round 6); date-only text stays text.
  '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00Z', '2026-03-01T00:00:00+00:00', '2026-02-01T12:30:00.000Z', '2025-12-31T23:59:59.999Z', '2026-01-01',
];

/** Literal patterns both engines read alike, and the patterns QA found JavaScript and PCRE read differently. */
const PATTERNS = [
  '^A', 'a', 'a$', '^$', '', 'x', 'ot$', '^Foxtrot$', 'É', '^É', '\\.', 'e', 'ho', '^D', 'by$', 'v', '^s', 'lat',
  '[[:alpha:]]', '\\p{L}', '\\AO', 'e\\Z', '^(a+)+$', '(?i)a', 'a|b', '2026-01-01T00:00:00Z',
];

const SCALAR_OPERATORS = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'] as const;
const LOGICAL_OPERATORS = ['$and', '$or', '$nor'] as const;

/** How long a "large" `$in` / `$nin` list is: long enough to show a per-record cost, short enough to stay quick. */
const LARGE_LIST_SIZES = [50, 300, 1_000];

interface Generator {
  pick<T>(values: readonly T[]): T;
  chance(probability: number): boolean;
  integer(below: number): number;
}

function createGenerator(seed: number): Generator {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    pick: values => values[Math.floor(random() * values.length)]!,
    chance: probability => random() < probability,
    integer: below => Math.floor(random() * below),
  };
}

function generateValue(generator: Generator): unknown {
  return generator.chance(0.12) ? null : generator.pick(VALUES);
}

/** A list of up to a few values, or now and then a large one mixing real values with many that match nothing. */
function generateList(generator: Generator, { minimum }: { minimum: number }): unknown[] {
  if (generator.chance(0.08)) {
    const size = generator.pick(LARGE_LIST_SIZES);
    return Array.from({ length: size }, (_, index) => (generator.chance(0.02) ? generateValue(generator) : generator.pick([`id-${index}`, index + 5_000, `${index}`])));
  }
  const length = minimum + generator.integer(4);
  return Array.from({ length }, () => generateValue(generator));
}

function generateOperator(generator: Generator, depth: number): [string, unknown] {
  const kind = generator.pick(['scalar', 'scalar', 'scalar', 'in', 'nin', 'all', 'exists', 'regex', 'not'] as const);
  switch (kind) {
    case 'scalar': return [generator.pick(SCALAR_OPERATORS), generator.pick(VALUES)];
    case 'in': return ['$in', generateList(generator, { minimum: 0 })];
    case 'nin': return ['$nin', generateList(generator, { minimum: 0 })];
    case 'all': return ['$all', generateList(generator, { minimum: 1 })];
    case 'exists': return ['$exists', generator.chance(0.5)];
    case 'regex': return ['$regex', generator.pick(PATTERNS)];
    case 'not': return depth > 1 ? ['$eq', generator.pick(VALUES)] : ['$not', Object.fromEntries([generateOperator(generator, depth + 1)])];
  }
}

function generateCondition(generator: Generator, depth: number): unknown {
  const kind = generator.pick(['value', 'value', 'missing', 'list', 'operators', 'operators', 'operators'] as const);
  switch (kind) {
    case 'value': return generator.pick(VALUES);
    case 'missing': return generator.chance(0.5) ? null : undefined;
    case 'list': return generateList(generator, { minimum: 0 }); // the bare-list shorthand
    case 'operators': return Object.fromEntries(Array.from({ length: generator.pick([1, 1, 2]) }, () => generateOperator(generator, depth)));
  }
}

function generateFilter(generator: Generator, depth: number): { [key: string]: unknown } {
  const entries = Array.from({ length: generator.pick([1, 1, 2]) }, (): [string, unknown] => {
    if (depth < 3 && generator.chance(0.3)) {
      return [generator.pick(LOGICAL_OPERATORS), Array.from({ length: generator.pick([1, 2, 3]) }, () => generateFilter(generator, depth + 1))];
    }
    return [generator.pick(FIELDS), generateCondition(generator, depth)];
  });
  return Object.fromEntries(entries);
}

/** The seeds the differential test runs, each with `DIFFERENTIAL_CASES_PER_SEED` filters: 20,000 in all. */
export const DIFFERENTIAL_SEEDS = [70_000, 4_100_000, 9_100_000, 123_456_789];
export const DIFFERENTIAL_CASES_PER_SEED = 5_000;

/** Random whitelisted filters for one seed, each to run on both engines. */
export function generateDifferentialCases(seed: number): DataFilters<DifferentialRecord>[] {
  return Array.from({ length: DIFFERENTIAL_CASES_PER_SEED }, (_, index) => generateFilter(createGenerator(seed + index), 0) as DataFilters<DifferentialRecord>);
}

/** QA's named shapes: the bare-list shorthand, the JS-vs-PCRE patterns, paths through lists and date-time text. */
export const DIFFERENTIAL_NAMED_CASES: [string, DataFilters<DifferentialRecord>][] = [
  ['bare list', { category: ['a', 'b'] } as never],
  ['bare list under $nor', { $nor: [{ category: ['a', 'b'] }] } as never],
  ['POSIX class under $not', { name: { $not: { $regex: '[[:alpha:]]' } } } as never],
  ['\\p{L} under $not', { name: { $not: { $regex: '\\p{L}' } } } as never],
  ['\\A under $not', { name: { $not: { $regex: '\\AO' } } } as never],
  ['\\Z', { name: { $regex: 'e\\Z' } } as never],
  ['catastrophic pattern', { name: { $regex: '^(a+)+$' } } as never],
  ['$ before a final newline', { name: { $regex: 'ot$' } } as never],
  ['negated literal pattern', { name: { $not: { $regex: '^A' } } } as never],
  ['QA r6 #1: missing through a list of plain values', { 'list.id': null } as never],
  ['QA r6 #1: undefined through a list of plain values', { 'list.id': undefined } as never],
  ['QA r6 #1: $exists false and $nin through a list of plain values', { 'mix.k': { $exists: false, $nin: [0, null] } } as never],
  ['QA r6 #1: missing through a list of lists', { 'nest.k': null } as never],
  ['QA r6 #1: $nin through a list of lists', { 'nest.k': { $nin: ['-', null] } } as never],
  ['QA r6 #1: missing through a list inside a list element', { 'nest.k.m': null } as never],
  ['QA r6 #3: ISO date-time text', { when: '2026-01-01T00:00:00.000Z' } as never],
  ['QA r6 #3: ISO date-time text in $in', { when: { $in: ['2026-02-01T12:30:00.000Z', 'x'] } } as never],
  ['QA r6 #3: ISO date-time text as a bound', { when: { $gte: '2026-02-01T00:00:00Z' } } as never],
];
