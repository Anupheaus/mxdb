import type { DataFilters, Record } from '@anupheaus/common';
import { DateTime } from 'luxon';

// Test-only: random filters drawn from MXDB's whitelist grammar (isReadableFilter.ts), run against the same records on
// the device and on the server. Both must return exactly the same records (Vision sc-2518). The records cover every
// shape a field can take — text, numbers, booleans, dates, null, missing, lists of values, lists of objects, objects,
// a value of the "wrong" type — so a filter that the two engines read differently shows up.

export interface DifferentialRecord extends Record {
  name: string;
  category?: string | null;
  value?: number | string;
  flag?: boolean | number;
  tags?: (string | null)[] | string;
  address?: { city?: string | null; zip?: string | number } | string;
  items?: { sku?: string | null; qty?: number }[];
  when?: DateTime;
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
];

const FIELDS = ['name', 'category', 'value', 'flag', 'tags', 'address.city', 'address.zip', 'items.sku', 'items.qty', 'when', 'id', 'missing'] as const;

const VALUES: unknown[] = [
  'a', 'b', '', 'A', 'ab', 'x', 'y', 'z', '5', 'Derby', 'derby', 'DE1', 's1', 's2', 'Alpha', 'Foxtrot\n', 'Échelle', 'd1', 'd4',
  0, 1, 2, 3, 5, 7, 10, 20, 30.5, -5, 1000, true, false, day('2026-01-01'), day('2026-02-15'), day('2026-03-01'),
];

/** Literal patterns both engines read alike, and the patterns QA found JavaScript and PCRE read differently. */
const PATTERNS = [
  '^A', 'a', 'a$', '^$', 'x', 'ot$', '^Foxtrot$', 'É', '^É', '\\.', 'e', 'ho', '^D', 'by$',
  '[[:alpha:]]', '\\p{L}', '\\AO', 'e\\Z', '^(a+)+$', '(?i)a', 'a|b',
];

const SCALAR_OPERATORS = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'] as const;
const LOGICAL_OPERATORS = ['$and', '$or', '$nor'] as const;

interface Generator {
  pick<T>(values: readonly T[]): T;
  chance(probability: number): boolean;
}

function createGenerator(seed: number): Generator {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
  return { pick: values => values[Math.floor(random() * values.length)]!, chance: probability => random() < probability };
}

function generateList(generator: Generator, { minimum }: { minimum: number }): unknown[] {
  const length = minimum + Math.floor(generator.pick([0, 1, 2, 3]));
  return Array.from({ length }, () => (generator.chance(0.15) ? null : generator.pick(VALUES)));
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

/** How many random filters are generated. */
const DIFFERENTIAL_CASE_COUNT = 1000;

/** Random whitelisted filters (plus QA's patterns), each to run on both engines. */
export function generateDifferentialCases(): [string, DataFilters<DifferentialRecord>][] {
  return Array.from({ length: DIFFERENTIAL_CASE_COUNT }, (_, index): [string, DataFilters<DifferentialRecord>] => {
    const filter = generateFilter(createGenerator(70_000 + index), 0);
    return [`differential ${index}: ${JSON.stringify(filter)}`, filter as DataFilters<DifferentialRecord>];
  });
}

/** QA's named shapes: the bare-list shorthand and the JS-vs-PCRE patterns, plain and negated. */
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
];
