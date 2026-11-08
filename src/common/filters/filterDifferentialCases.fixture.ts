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
  // List items with their own `id` (the record's is `_id` on the server, an item's is not) and mixed items (sc-2758).
  { id: 'd15', name: 'November', items: [{ id: 's1', sku: 's2', qty: 2 }, { id: 'd1', qty: 5 }], list: [{ id: 'd1', ref: 'd4' }], tags: [1, 'x', null, ['y']] },
  // Letters whose case folds differently across engines if either gets it wrong (sc-2783): the Kelvin sign, the long
  // s, Greek sigmas, dotted and dotless i, sharp s; and an address in capitals beside one in lower case.
  { id: 'd16', name: 'Oscar K', category: 'ſ', tags: ['ΣΑΣ', 'σας', 'İstanbul', 'ıi', 'Straße'], address: { city: 'LEEDS', zip: 'de1' } },
];

/** Fields of the list items above, for `$elemMatch` item filters. */
const ITEM_FIELDS = ['sku', 'qty', 'k', 'k.m', 'b', 'ref', 'id', 'missing'] as const;

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
  // Case-insensitive edge letters (sc-2783).
  'k', 'K', 's', 'S', 'σ', 'Σ', 'ς', 'i', 'I', 'İ', 'ı', 'ss', 'SS', 'ß', 'leeds', '^DE', 'é', 'É', '^ALPHA$',
];

/** Pattern options: 'i' and none are readable; the rest must match nothing on both engines (sc-2783). */
const PATTERN_OPTIONS = ['i', 'i', 'i', '', 'm', 's', 'x', 'im'];

/** Keys of nested objects in the records, for nested conditions (sc-2783). */
const NESTED_KEYS = ['city', 'zip', 'sku', 'qty', 'k', 'm', 'a', 'b', 'ref', 'id', 'missing'] as const;

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
  const kind = generator.pick(['scalar', 'scalar', 'scalar', 'in', 'nin', 'all', 'exists', 'regex', 'not', 'elemMatch', 'elemMatch'] as const);
  switch (kind) {
    case 'scalar': return [generator.pick(SCALAR_OPERATORS), generator.pick(VALUES)];
    case 'in': return ['$in', generateList(generator, { minimum: 0 })];
    case 'nin': return ['$nin', generateList(generator, { minimum: 0 })];
    case 'all': return ['$all', generateList(generator, { minimum: 1 })];
    case 'exists': return ['$exists', generator.chance(0.5)];
    case 'regex': return ['$regex', generator.pick(PATTERNS)];
    case 'not': return depth > 1 ? ['$eq', generator.pick(VALUES)] : ['$not', Object.fromEntries([generateOperator(generator, depth + 1)])];
    case 'elemMatch': return depth > 1 ? ['$eq', generator.pick(VALUES)] : ['$elemMatch', generateItemCondition(generator, depth + 1)];
  }
}

// ─── $elemMatch (sc-2758) ─────────────────────────────────────────────────────

/** An operator an `$elemMatch` item condition may hold. */
function generateItemOperator(generator: Generator, depth: number): [string, unknown] {
  const kind = generator.pick(['scalar', 'scalar', 'in', 'nin', 'regex', 'not'] as const);
  switch (kind) {
    case 'scalar': return [generator.pick(SCALAR_OPERATORS), generator.pick(VALUES)];
    case 'in': return ['$in', generateList(generator, { minimum: 0 })];
    case 'nin': return ['$nin', generateList(generator, { minimum: 0 })];
    case 'regex': return ['$regex', generator.pick(PATTERNS)];
    case 'not': return depth > 2 ? ['$eq', generator.pick(VALUES)] : ['$not', Object.fromEntries([generateItemOperator(generator, depth + 1)])];
  }
}

/** One condition on an item field, from the same grammar as a record field's. */
function generateItemFieldCondition(generator: Generator, depth: number): [string, unknown] {
  return [generator.pick(ITEM_FIELDS), generateCondition(generator, depth + 1)];
}

/** An item filter: one or two item-field conditions, sometimes under `$or` / `$and` / `$nor`. */
function generateItemFilter(generator: Generator, depth: number): { [key: string]: unknown } {
  const conditions = () => Object.fromEntries(Array.from({ length: generator.pick([1, 1, 2]) }, () => generateItemFieldCondition(generator, depth)));
  if (!generator.chance(0.3)) return conditions();
  return { [generator.pick(LOGICAL_OPERATORS)]: Array.from({ length: generator.pick([1, 2]) }, conditions) };
}

/** An `$elemMatch` operand: item operators, or an item filter. */
function generateItemCondition(generator: Generator, depth: number): { [key: string]: unknown } {
  if (generator.chance(0.5)) return generateItemFilter(generator, depth);
  return Object.fromEntries(Array.from({ length: generator.pick([1, 1, 2]) }, () => generateItemOperator(generator, depth)));
}

function generateCondition(generator: Generator, depth: number): unknown {
  const kind = generator.pick(['value', 'value', 'missing', 'list', 'operators', 'operators', 'operators', 'pattern', 'nested'] as const);
  switch (kind) {
    case 'value': return generator.pick(VALUES);
    case 'missing': return generator.chance(0.5) ? null : undefined;
    case 'list': return generateList(generator, { minimum: 0 }); // the bare-list shorthand
    case 'operators': return Object.fromEntries(Array.from({ length: generator.pick([1, 1, 2]) }, () => generateOperator(generator, depth)));
    case 'pattern': return generatePatternCondition(generator);
    case 'nested': return depth > 2 ? generator.pick(VALUES) : generateNestedCondition(generator, depth);
  }
}

/** A `$regex` with `$options`, sometimes negated (sc-2783). */
function generatePatternCondition(generator: Generator): unknown {
  const pattern = { $regex: generator.pick(PATTERNS), $options: generator.pick(PATTERN_OPTIONS) };
  return generator.chance(0.3) ? { $not: pattern } : pattern;
}

/** A nested condition: one or two nested fields, each its own condition (sc-2783). */
function generateNestedCondition(generator: Generator, depth: number): unknown {
  return Object.fromEntries(Array.from({ length: generator.pick([1, 1, 2]) }, () => [generator.pick(NESTED_KEYS), generateCondition(generator, depth + 1)]));
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
  // sc-2758: $elemMatch through every shape a list can take.
  ['$elemMatch: an item equal to a value', { tags: { $elemMatch: { $eq: 'y' } } } as never],
  ['$elemMatch: an item that is not a value (lists and nulls as items)', { tags: { $elemMatch: { $ne: 'x' } } } as never],
  ['$elemMatch: $nin of nothing (any item at all)', { tags: { $elemMatch: { $nin: [] } } } as never],
  ['$elemMatch: a null item', { tags: { $elemMatch: { $in: [null] } } } as never],
  ['$elemMatch: two bounds on one item', { value: { $elemMatch: { $gte: 10, $lt: 20 } } } as never],
  ['$elemMatch: an item inside a list of lists is not expanded', { value: { $elemMatch: { $eq: 10 } } } as never],
  ['$elemMatch: a negated item condition', { tags: { $elemMatch: { $not: { $regex: '^x' } } } } as never],
  ['$elemMatch: two fields on one item', { items: { $elemMatch: { sku: 's2', qty: { $gte: 2 } } } } as never],
  ['$elemMatch: an item field that is missing (null and list items)', { items: { $elemMatch: { sku: null } } } as never],
  ['$elemMatch: an item field that does not exist', { nest: { $elemMatch: { k: { $exists: false } } } } as never],
  ['$elemMatch: an item\'s own id', { items: { $elemMatch: { id: 'd1' } } } as never],
  ['$elemMatch: an item\'s own id is not the record\'s', { list: { $elemMatch: { id: 'd15' } } } as never],
  ['$elemMatch: an item filter starting with $or', { items: { $elemMatch: { $or: [{ sku: 's1' }, { qty: { $gt: 4 } }] } } } as never],
  ['$elemMatch: an item filter under $nor', { items: { $elemMatch: { $nor: [{ sku: 's1' }] } } } as never],
  ['$elemMatch: a path through a list of objects', { 'items.qty': { $elemMatch: { $gte: 5 } } } as never],
  ['$elemMatch: a dotted path inside an item', { nest: { $elemMatch: { 'k.m': 5 } } } as never],
  ['$elemMatch: a list of mixed items', { mix: { $elemMatch: { k: 'v' } } } as never],
  ['$elemMatch: nested, on an item field that is a list', { 'deep.a': { $elemMatch: { b: { $elemMatch: { $eq: 2 } } } } } as never],
  ['$elemMatch: a field that is not a list', { mix: { $elemMatch: { k: { $exists: true } } } } as never],
  ['$elemMatch: under $not', { tags: { $not: { $elemMatch: { $eq: 'x' } } } } as never],
  ['$elemMatch: under $nor', { $nor: [{ items: { $elemMatch: { qty: { $gt: 1 } } } }] } as never],
  ['$elemMatch: ISO date-time text in an item condition', { when: { $elemMatch: { $eq: '2026-01-01T00:00:00Z' } } } as never],
  // sc-2783: nested conditions, "does not exist", comparisons across kinds and case-insensitive patterns.
  ['nested: a city', { address: { city: 'Derby' } } as never],
  ['nested: a city and a zip', { address: { city: 'derby', zip: 7 } } as never],
  ['nested: a missing city', { address: { city: null } } as never],
  ['nested: through a list of objects', { items: { sku: 's1', qty: { $gte: 2 } } } as never],
  ['nested: an item id', { list: { id: 'd1' } } as never],
  ['nested: two levels', { deep: { a: { b: 1 } } } as never],
  ['nested: under $nor', { $nor: [{ address: { city: { $exists: true } } }] } as never],
  ['nested and dotted on the same path', { address: { city: 'Derby' }, 'address.city': { $ne: 'Leeds' } } as never],
  ['$exists false beside a null', { category: { $exists: false } } as never],
  ['a number bound never reads text', { value: { $gt: 1 } } as never],
  ['a text bound never reads numbers', { value: { $lt: '9' } } as never],
  ['ignoring case: a', { name: { $regex: 'a', $options: 'i' } } as never],
  ['ignoring case: the Kelvin sign', { name: { $regex: 'k', $options: 'i' } } as never],
  ['ignoring case: the long s', { category: { $regex: 's', $options: 'i' } } as never],
  ['ignoring case: final sigma', { tags: { $regex: 'ς', $options: 'i' } } as never],
  ['ignoring case: dotted capital I', { tags: { $regex: 'i̇', $options: 'i' } } as never],
  ['ignoring case: dotless i', { tags: { $regex: 'I', $options: 'i' } } as never],
  ['ignoring case: sharp s is not ss', { tags: { $regex: 'SS', $options: 'i' } } as never],
  ['ignoring case: accents', { name: { $regex: 'é', $options: 'i' } } as never],
  ['ignoring case: anchored, before a final newline', { name: { $regex: '^foxtrot$', $options: 'i' } } as never],
  ['ignoring case, negated', { 'address.city': { $not: { $regex: 'LEEDS', $options: 'i' } } } as never],
  ['a RegExp ignoring case', { 'address.city': /^derby$/i } as never],
  ['a RegExp under $not', { name: { $not: /^a/i } } as never],
  ['option m matches nothing', { name: { $regex: 'a', $options: 'm' } } as never],
];
