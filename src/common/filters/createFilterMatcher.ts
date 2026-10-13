import { is, type DataFilters } from '@anupheaus/common';
import { DateTime } from 'luxon';
import { parseLiteralPattern } from './literalPattern';

// The device's ONLY filter evaluator. It reads the canonical filters `normaliseFilterConditions` produces (the
// whitelist grammar; bare lists as $in; ISO date-time text as DateTime; $regex as canonical literal text) exactly as
// MongoDB reads the same filter on the server. The rules, in one place:
//
// PATHS (`a.b.c`), as MongoDB walks them:
// - Through an object: read the next field. A field that is absent is "missing".
// - Through a list in the MIDDLE of a path: read the rest of the path in each element that is an object. Elements
//   that are plain values or lists are SKIPPED — they neither match nor count as "missing" (`{ 'list.id': null }`
//   does not match `list: [1, 2]`). An empty list reaches nothing and is not "missing" either.
// - Into a plain value (text, number, date, null) in the middle of a path that is not inside a list: "missing".
// - At the END of a path, a list is matched by itself and by each of its elements (one level only, never by the
//   elements of a list inside it).
//
// VALUES:
// - `null` matches a path that is missing somewhere, or that reaches null.
// - Equality and order compare within one type only: numbers with numbers, text with text (ordered by code point, as
//   MongoDB orders UTF-8 bytes), booleans with booleans, dates with dates. `5` never equals `'5'`.
// - DATES: a Date, a luxon DateTime and ISO date-time text in a FILTER are one thing: an instant, compared by its
//   milliseconds (normaliseFilterConditions turns ISO date-time text into a DateTime, exactly as the transport to the
//   server does, so the server compares the same instant). A record field holding text is text.
// - `$ne` / `$nin` / `$not` / `$nor` are exact negations, so a missing field counts as "not".
// - `$regex` holds a literal pattern (literalPattern.ts), tested in linear time.
//
// The filter is COMPILED once per query (paths split, $in / $nin lists made into sets), then run per record.
// `ServerDbCollection.differential.tests.ts` runs random whitelisted filters through this and MongoDB and asserts
// the same records come back. Vision sc-2518.

type FilterObject = { [key: string]: unknown };

/** What a path reads on one record. */
interface PathValues {
  /** Every value the path reaches, plus the elements of a list at its end. */
  values: unknown[];
  /** Some branch of the path found nothing (a missing field, or a plain value where an object was needed). */
  isMissingSomewhere: boolean;
  /** Some branch of the path reached a value. */
  exists: boolean;
}

/** A compiled condition on what one path reads. */
type PathCondition = (path: PathValues) => boolean;

/** A compiled filter: whether one record meets it. */
export type FilterMatcher = (record: object) => boolean;

// ─── Values ───────────────────────────────────────────────────────────────────

function isDateLike(value: unknown): value is Date | DateTime {
  return value instanceof Date || DateTime.isDateTime(value);
}

function toMillis(value: Date | DateTime): number {
  return value instanceof Date ? value.getTime() : value.toMillis();
}

/** An object a path can walk into: not a list, not a date, not null. */
function isDocument(value: unknown): value is FilterObject {
  return value != null && typeof value === 'object' && !Array.isArray(value) && !isDateLike(value);
}

/** The first and last UTF-16 surrogate code units, and the start of the units that sort above them by code point. */
const SURROGATE_FIRST = 0xd800;
const ABOVE_SURROGATES = 0xe000;
const SURROGATE_SHIFT = 0x2000;
const ABOVE_SURROGATES_SHIFT = 0x800;

/** A UTF-16 code unit moved so that comparing units orders strings by code point (as MongoDB orders UTF-8 bytes). */
function toCodePointOrder(unit: number): number {
  if (unit < SURROGATE_FIRST) return unit;
  return unit >= ABOVE_SURROGATES ? unit - ABOVE_SURROGATES_SHIFT : unit + SURROGATE_SHIFT;
}

function compareStrings(first: string, second: string): number {
  if (first === second) return 0;
  const length = Math.min(first.length, second.length);
  for (let index = 0; index < length; index += 1) {
    const firstUnit = first.charCodeAt(index);
    const secondUnit = second.charCodeAt(index);
    if (firstUnit !== secondUnit) return toCodePointOrder(firstUnit) - toCodePointOrder(secondUnit);
  }
  return first.length - second.length;
}

/** The order of `value` against a (non-null, scalar) `operand` of the same type, or undefined when not comparable. */
function compare(value: unknown, operand: unknown): number | undefined {
  if (typeof operand === 'number') return typeof value === 'number' ? value - operand : undefined;
  if (typeof operand === 'string') return typeof value === 'string' ? compareStrings(value, operand) : undefined;
  if (typeof operand === 'boolean') return typeof value === 'boolean' ? Number(value) - Number(operand) : undefined;
  if (isDateLike(operand)) return isDateLike(value) ? toMillis(value) - toMillis(operand) : undefined;
  return undefined;
}

/** A set of scalar operands, looked up by type in constant time; `null` means "missing". */
interface ScalarSet {
  has(value: unknown): boolean;
  hasNull: boolean;
}

function createScalarSet(operands: unknown[]): ScalarSet {
  const strings = new Set<string>();
  const numbers = new Set<number>();
  const booleans = new Set<boolean>();
  const dates = new Set<number>();
  let hasNull = false;
  for (const operand of operands) {
    if (operand === null) hasNull = true;
    else if (typeof operand === 'string') strings.add(operand);
    else if (typeof operand === 'number') numbers.add(operand);
    else if (typeof operand === 'boolean') booleans.add(operand);
    else if (isDateLike(operand)) dates.add(toMillis(operand));
  }
  const has = (value: unknown): boolean => {
    if (typeof value === 'string') return strings.has(value);
    if (typeof value === 'number') return numbers.has(value);
    if (typeof value === 'boolean') return booleans.has(value);
    return isDateLike(value) && dates.has(toMillis(value));
  };
  return { has, hasNull };
}

/** Whether the path reaches any value in `set` (or, when it holds null, is missing or reaches null). */
function createMembership(operands: unknown[]): PathCondition {
  const set = createScalarSet(operands);
  return ({ values, isMissingSomewhere }) => {
    if (set.hasNull && (isMissingSomewhere || values.includes(null))) return true;
    return values.some(set.has);
  };
}

// ─── Paths ────────────────────────────────────────────────────────────────────

function collect(value: unknown, segments: string[], index: number, out: PathValues): void {
  if (index === segments.length) {
    if (value === undefined) { out.isMissingSomewhere = true; return; }
    out.exists = true;
    out.values.push(value);
    if (Array.isArray(value)) out.values.push(...value);
    return;
  }
  if (Array.isArray(value)) {
    // Mid-path list: walk into its objects only; plain values and lists inside it are skipped, not "missing".
    for (const element of value) if (isDocument(element)) collect(element, segments, index, out);
    return;
  }
  if (!isDocument(value)) { out.isMissingSomewhere = true; return; }
  collect(value[segments[index]!], segments, index + 1, out);
}

function createPathReader(path: string): (record: object) => PathValues {
  const segments = path.split('.');
  return record => {
    const out: PathValues = { values: [], isMissingSomewhere: false, exists: false };
    collect(record, segments, 0, out);
    return out;
  };
}

// ─── Operators ────────────────────────────────────────────────────────────────

function createOrder(operand: unknown, accepts: (order: number) => boolean): PathCondition {
  return ({ values }) => values.some(value => {
    const order = compare(value, operand);
    return order != null && accepts(order);
  });
}

function createPattern(operand: unknown): PathCondition {
  const pattern = parseLiteralPattern(operand as string)!;
  return ({ values }) => values.some(value => is.string(value) && pattern.test(value));
}

function negate(condition: PathCondition): PathCondition {
  return path => !condition(path);
}

function compileOperator(operator: string, operand: unknown): PathCondition {
  switch (operator) {
    case '$eq': return createMembership([operand]);
    case '$ne': return negate(createMembership([operand]));
    case '$gt': return createOrder(operand, order => order > 0);
    case '$gte': return createOrder(operand, order => order >= 0);
    case '$lt': return createOrder(operand, order => order < 0);
    case '$lte': return createOrder(operand, order => order <= 0);
    case '$in': return createMembership(operand as unknown[]);
    case '$nin': return negate(createMembership(operand as unknown[]));
    case '$all': {
      const items = (operand as unknown[]).map(item => createMembership([item]));
      return path => items.every(item => item(path));
    }
    case '$exists': return ({ exists }) => exists === operand;
    case '$regex': return createPattern(operand);
    case '$not': return negate(compileOperators(operand as FilterObject));
    // The whitelist lets no other operator through; never read one as a match.
    default: return () => false;
  }
}

function compileOperators(operators: FilterObject): PathCondition {
  const conditions = Object.entries(operators).map(([operator, operand]) => compileOperator(operator, operand));
  return path => conditions.every(condition => condition(path));
}

// ─── Filters ──────────────────────────────────────────────────────────────────

function compileField(field: string, condition: unknown): FilterMatcher {
  const read = createPathReader(field);
  const test = is.plainObject(condition) ? compileOperators(condition) : createMembership([condition]);
  return record => test(read(record));
}

function compileFilterObject(filter: FilterObject): FilterMatcher {
  const matchers = Object.entries(filter).map(([key, value]): FilterMatcher => {
    if (key === '$and' || key === '$or' || key === '$nor') {
      const branches = (value as FilterObject[]).map(compileFilterObject);
      if (key === '$and') return record => branches.every(branch => branch(record));
      if (key === '$or') return record => branches.some(branch => branch(record));
      return record => !branches.some(branch => branch(record));
    }
    return compileField(key, value);
  });
  return record => matchers.every(matcher => matcher(record));
}

/**
 * Compiles `filters`, which must already be canonical (`normaliseFilterConditions`), into a test of one record —
 * once per query, so a large `$in` list becomes a set once, not once per record. No filters, or `{}`, match every
 * record.
 */
export function createFilterMatcher<T extends object>(filters: DataFilters<T> | undefined): FilterMatcher {
  if (filters == null) return () => true;
  return compileFilterObject(filters as FilterObject);
}
