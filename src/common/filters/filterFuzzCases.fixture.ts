import type { DataFilters } from '@anupheaus/common';
import type { OperandCaseRecord } from './filterOperandCases.fixture';

// Test-only: random nested queries over OPERAND_CASE_RECORDS with one deliberately broken node, placed at every depth
// and in every kind of position (a field's condition, a logical branch, the operand of $not / $elemMatch). Each case
// comes in two forms: the broken query, and the same query with the broken node replaced by a sound condition that
// matches nothing. No engine may ever return a record for the broken form that the match-nothing form does not
// return — and MXDB's contract is stronger: a query holding a broken node returns nothing at all (Vision sc-2518).

type Node = { [key: string]: unknown };

/** Where the broken node sits in the generated query. */
export type FuzzHoleKind = 'field' | 'branch' | 'not' | 'elemMatch';

export interface FuzzCase {
  label: string;
  broken: DataFilters<OperandCaseRecord>;
  matchNothing: DataFilters<OperandCaseRecord>;
}

/** Marks the hole while a query is generated; replaced before the query is used. */
const HOLE = Symbol('Hole');

/** Broken conditions for a field (the value of `{ field: … }`), each a different way a node can be unreadable. */
const BROKEN_FIELD_CONDITIONS: unknown[] = [
  {}, { $in: undefined }, { $in: null }, { $in: 'a' }, { $nin: undefined }, { $all: [] }, { $eq: undefined }, { $ne: null },
  { $gt: undefined }, { $lte: {} }, { $exists: 'yes' }, { $size: -1 }, { $regex: 5 }, { $not: {} }, { $not: { $in: undefined } },
  { $elemMatch: {} }, { $elemMatch: { $in: undefined } }, { $bogus: 1 }, { $eq: 'a', sub: 1 }, { sub: {} }, { $gte: Number.NaN },
];

/** Broken branches of a logical operator. */
const BROKEN_BRANCHES: unknown[] = [
  { category: {} }, { category: { $in: undefined } }, { $or: [] }, { $and: undefined }, { $nor: 'x' }, { $bogus: 1 }, 'not a filter',
];

/** Broken operator objects for `$not` / `$elemMatch`. */
const BROKEN_OPERATORS: unknown[] = [{}, { $in: undefined }, { $eq: null }, { $bogus: 1 }, { $gt: [] }, 'x'];

/** Sound conditions, each true for some records and false for others. */
const SOUND_CONDITIONS: Node[] = [
  { category: 'a' }, { category: { $in: ['a', 'b'] } }, { value: { $gt: 15 } }, { value: { $lte: 30 } }, { category: { $ne: 'b' } },
  { tags: { $all: ['x'] } }, { tags: { $size: 1 } }, { category: { $exists: true } }, { name: { $regex: '^T' } },
  { value: { $not: { $gt: 25 } } }, { category: undefined }, { value: { $gte: 10, $lt: 40 } },
];

/** A small seeded random number generator (mulberry32), so every run generates the same cases. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Generator {
  pick<T>(values: readonly T[]): T;
  chance(probability: number): boolean;
}

function createGenerator(seed: number): Generator {
  const random = createRandom(seed);
  return {
    pick: values => values[Math.floor(random() * values.length)]!,
    chance: probability => random() < probability,
  };
}

/** The hole as it sits in its position: in a field's condition, as a branch, or as the operand of $not / $elemMatch. */
function holeNode(kind: FuzzHoleKind): Node {
  switch (kind) {
    case 'field': return { category: HOLE };
    case 'branch': return { $or: [HOLE, { name: 'Two' }] };
    case 'not': return { value: { $not: HOLE } };
    case 'elemMatch': return { tags: { $elemMatch: HOLE } };
  }
}

const LOGICAL_OPERATORS = ['$and', '$or', '$nor'] as const;

/** A random filter `depth` levels deep, holding the hole at its deepest level. */
function generateFilter(generator: Generator, depth: number, kind: FuzzHoleKind): Node {
  if (depth === 0) return generator.chance(0.5) ? holeNode(kind) : { ...generator.pick(SOUND_CONDITIONS), ...holeNode(kind) };
  const operator = generator.pick(LOGICAL_OPERATORS);
  const branches: Node[] = [generateFilter(generator, depth - 1, kind)];
  if (generator.chance(0.6)) branches.push(generator.pick(SOUND_CONDITIONS));
  if (generator.chance(0.3)) branches.unshift(generator.pick(SOUND_CONDITIONS));
  const filter: Node = { [operator]: branches };
  return generator.chance(0.4) ? { ...generator.pick(SOUND_CONDITIONS), ...filter } : filter;
}

/** A copy of `value` with the hole replaced by `replacement`. */
function fillHole(value: unknown, replacement: unknown): unknown {
  if (value === HOLE) return replacement;
  if (Array.isArray(value)) return value.map(item => fillHole(item, replacement));
  if (value != null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillHole(item, replacement)]));
  }
  return value;
}

/** What replaces the hole in the match-nothing form: a sound condition that no record meets. */
const MATCH_NOTHING_BY_KIND: { [kind in FuzzHoleKind]: unknown } = {
  field: { $in: [] },
  branch: { id: { $in: [] } },
  not: { $in: [] },
  elemMatch: { $in: [] },
};

const BROKEN_BY_KIND: { [kind in FuzzHoleKind]: unknown[] } = {
  field: BROKEN_FIELD_CONDITIONS,
  branch: BROKEN_BRANCHES,
  not: BROKEN_OPERATORS,
  elemMatch: BROKEN_OPERATORS,
};

// ─── Garbage ──────────────────────────────────────────────────────────────────
//
// Arbitrary values of any shape, biased towards filter-like ones (real field names, real and fake operators, odd
// values) so that some come out readable and many come out nearly-but-not-quite readable.

const GARBAGE_KEYS = [
  'name', 'category', 'value', 'tags', 'id', 'missing.path', '$and', '$or', '$nor', '$not', '$eq', '$ne', '$gt', '$gte',
  '$lt', '$lte', '$in', '$nin', '$all', '$exists', '$regex', '$options', '$elemMatch', '$size', '$type', '$where',
  '$expr', '$ni', '$like', '$bogus', '__proto__', 'constructor', 'tags.0', '', 'x\') OR 1=1 OR (\'', 'a b',
] as const;

const GARBAGE_SCALARS: unknown[] = [
  undefined, null, true, false, 0, 1, -1, 1.5, 15, 25, Number.NaN, Number.POSITIVE_INFINITY, '', 'a', 'b', 'One', 'x', 'y',
  '^T', '(', '[', 'string', new Date('2026-01-01T00:00:00Z'), new Date(Number.NaN),
];

function generateGarbage(generator: Generator, depth: number): unknown {
  const roll = generator.pick([0, 1, 2, 3, 4, 5] as const);
  if (depth <= 0 || roll <= 1) return generator.pick(GARBAGE_SCALARS);
  if (roll === 2) return Array.from({ length: generator.pick([0, 1, 2, 3]) }, () => generateGarbage(generator, depth - 1));
  const entries = Array.from({ length: generator.pick([0, 1, 1, 2, 3]) }, () => [generator.pick(GARBAGE_KEYS), generateGarbage(generator, depth - 1)] as const);
  return Object.fromEntries(entries);
}

/**
 * `filters` with every missing value written as `null` — exactly what a readable filter reaches the engines as. The
 * garbage tests compare against it: a readable filter must pass the whitelist unchanged, so the engines evaluate it
 * exactly as they did before the whitelist existed.
 */
export function withMissingAsNull(filters: unknown): unknown {
  if (filters === undefined) return null;
  if (Array.isArray(filters)) return filters.map(withMissingAsNull);
  if (filters != null && typeof filters === 'object' && Object.getPrototypeOf(filters) === Object.prototype) {
    return Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, withMissingAsNull(value)]));
  }
  return filters;
}

/** How many garbage values are generated. */
const GARBAGE_CASE_COUNT = 400;

/** Arbitrary values of any shape, offered as filters. */
export function generateGarbageCases(): [string, unknown][] {
  return Array.from({ length: GARBAGE_CASE_COUNT }, (_, index): [string, unknown] => {
    const generator = createGenerator(90_000 + index);
    const garbage = generateGarbage(generator, generator.pick([1, 2, 3, 4, 5]));
    return [`garbage ${index}: ${JSON.stringify(garbage) ?? String(garbage)}`, garbage];
  });
}

/** How deep the generated queries go (0 = the broken node is in the query itself). */
const MAX_DEPTH = 3;

/** Seeds per depth and kind; each seed picks a broken node and a random tree around it. */
const SEEDS_PER_SHAPE = 12;

/** Every generated case: each depth × each kind of position × several seeds (so several broken nodes and trees). */
export function generateFuzzCases(): [string, FuzzCase][] {
  const cases: [string, FuzzCase][] = [];
  for (let depth = 0; depth <= MAX_DEPTH; depth += 1) {
    for (const kind of Object.keys(MATCH_NOTHING_BY_KIND) as FuzzHoleKind[]) {
      for (let seedIndex = 0; seedIndex < SEEDS_PER_SHAPE; seedIndex += 1) {
        const seed = (depth * 1_000) + (seedIndex * 17) + kind.length;
        const generator = createGenerator(seed);
        const tree = generateFilter(generator, depth, kind);
        const broken = generator.pick(BROKEN_BY_KIND[kind]);
        const label = `depth ${depth}, ${kind}, seed ${seed}: ${JSON.stringify(fillHole(tree, broken))}`;
        cases.push([label, {
          label,
          broken: fillHole(tree, broken) as DataFilters<OperandCaseRecord>,
          matchNothing: fillHole(tree, MATCH_NOTHING_BY_KIND[kind]) as DataFilters<OperandCaseRecord>,
        }]);
      }
    }
  }
  return cases;
}
