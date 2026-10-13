import { is, type DataFilters } from '@anupheaus/common';
import { DateTime } from 'luxon';
import { parseLiteralPattern, type LiteralPattern } from './literalPattern';

// The device's ONLY filter evaluator, reading the canonical filters `normaliseFilterConditions` produces (the
// whitelist grammar, with bare lists rewritten to $in) exactly as MongoDB reads the same filter on the server:
//
// - A path through a list of objects (`items.sku`) reads every element's value; a field holding a list is matched by
//   any of its elements (`{ tags: 'x' }` matches `tags: ['x', 'y']`).
// - `null` (or a missing value) matches a field that is missing or null, or a list holding null.
// - Equality and ordering compare within one type only: numbers with numbers, text with text (by code point, as
//   MongoDB compares UTF-8 bytes), dates with dates (by instant), booleans with booleans. `5` never equals `'5'`.
// - `$ne` / `$nin` / `$not` / `$nor` are exactly the negation of what they wrap, so a field that is missing counts
//   as "not" — the same on both engines, by construction.
// - `$regex` holds a literal pattern (see literalPattern.ts), matched in linear time, never by a backtracking engine.
//
// Vision sc-2518. A differential test runs random whitelisted filters through this and through MongoDB and asserts
// the same records come back.

type FilterObject = { [key: string]: unknown };

/** What a path reads on one record: the values it reaches, and whether any branch of it found nothing. */
interface PathValues {
  values: unknown[];
  isMissingSomewhere: boolean;
  exists: boolean;
}

function isDateLike(value: unknown): value is Date | DateTime {
  return value instanceof Date || DateTime.isDateTime(value);
}

function toMillis(value: Date | DateTime): number {
  return value instanceof Date ? value.getTime() : value.toMillis();
}

/** Every value `segments` reaches from `value`, walking into lists of objects as MongoDB does. */
function collect(value: unknown, segments: string[], out: PathValues): void {
  if (segments.length === 0) {
    if (value === undefined) { out.isMissingSomewhere = true; return; }
    out.exists = true;
    out.values.push(value);
    // A list is matched by its elements as well as by itself.
    if (Array.isArray(value)) out.values.push(...value);
    return;
  }
  if (Array.isArray(value)) {
    // An empty list reaches nothing — and, as in MongoDB, is not "missing" either: `{ 'items.sku': null }` does not
    // match `items: []`.
    value.forEach(element => collect(element, segments, out));
    return;
  }
  if (value == null || typeof value !== 'object' || isDateLike(value)) { out.isMissingSomewhere = true; return; }
  const [segment, ...rest] = segments;
  collect((value as FilterObject)[segment!], rest, out);
}

function readPath(record: unknown, path: string): PathValues {
  const out: PathValues = { values: [], isMissingSomewhere: false, exists: false };
  collect(record, path.split('.'), out);
  return out;
}

/** The type bracket a value compares within, or undefined for values that compare with nothing (lists, objects). */
function bracketOf(value: unknown): 'number' | 'string' | 'date' | 'boolean' | 'null' | undefined {
  if (value === null) return 'null';
  if (is.number(value)) return 'number';
  if (is.string(value)) return 'string';
  if (is.boolean(value)) return 'boolean';
  if (isDateLike(value)) return 'date';
  return undefined;
}

function compareStrings(first: string, second: string): number {
  const firstPoints = Array.from(first);
  const secondPoints = Array.from(second);
  const length = Math.min(firstPoints.length, secondPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = firstPoints[index]!.codePointAt(0)! - secondPoints[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return firstPoints.length - secondPoints.length;
}

/** The order of two values of the same bracket, or undefined when they are not comparable. */
function compare(value: unknown, operand: unknown): number | undefined {
  const bracket = bracketOf(value);
  if (bracket == null || bracket === 'null' || bracket !== bracketOf(operand)) return undefined;
  switch (bracket) {
    case 'number': return (value as number) - (operand as number);
    case 'string': return compareStrings(value as string, operand as string);
    case 'boolean': return Number(value) - Number(operand);
    case 'date': return toMillis(value as Date | DateTime) - toMillis(operand as Date | DateTime);
  }
}

function matchesValue({ values, isMissingSomewhere }: PathValues, operand: unknown): boolean {
  if (operand === null) return isMissingSomewhere || values.includes(null);
  return values.some(value => compare(value, operand) === 0);
}

function matchesOrder(values: unknown[], operand: unknown, accepts: (order: number) => boolean): boolean {
  return values.some(value => {
    const order = compare(value, operand);
    return order != null && accepts(order);
  });
}

function matchesPattern(values: unknown[], pattern: LiteralPattern): boolean {
  return values.some(value => is.string(value) && pattern.test(value));
}

function matchesOperator(path: PathValues, [operator, operand]: [string, unknown]): boolean {
  switch (operator) {
    case '$eq': return matchesValue(path, operand);
    case '$ne': return !matchesValue(path, operand);
    case '$gt': return matchesOrder(path.values, operand, order => order > 0);
    case '$gte': return matchesOrder(path.values, operand, order => order >= 0);
    case '$lt': return matchesOrder(path.values, operand, order => order < 0);
    case '$lte': return matchesOrder(path.values, operand, order => order <= 0);
    case '$in': return (operand as unknown[]).some(item => matchesValue(path, item));
    case '$nin': return !(operand as unknown[]).some(item => matchesValue(path, item));
    case '$all': return (operand as unknown[]).every(item => matchesValue(path, item));
    case '$exists': return path.exists === operand;
    case '$regex': return matchesPattern(path.values, parseLiteralPattern(operand as string)!);
    case '$not': return !matchesOperators(path, operand as FilterObject);
    // The whitelist lets no other operator through; never read one as a match.
    default: return false;
  }
}

function matchesOperators(path: PathValues, operators: FilterObject): boolean {
  return Object.entries(operators).every(entry => matchesOperator(path, entry));
}

function matchesField(record: unknown, [field, condition]: [string, unknown]): boolean {
  const path = readPath(record, field);
  if (is.plainObject(condition)) return matchesOperators(path, condition);
  return matchesValue(path, condition);
}

function matchesFilterObject(record: unknown, filter: FilterObject): boolean {
  return Object.entries(filter).every(([key, value]) => {
    switch (key) {
      case '$and': return (value as FilterObject[]).every(branch => matchesFilterObject(record, branch));
      case '$or': return (value as FilterObject[]).some(branch => matchesFilterObject(record, branch));
      case '$nor': return !(value as FilterObject[]).some(branch => matchesFilterObject(record, branch));
      default: return matchesField(record, [key, value]);
    }
  });
}

/**
 * Whether `record` meets `filters`, which must already be canonical (`normaliseFilterConditions`). No filters, or
 * `{}`, match every record.
 */
export function matchesFilter<T extends object>(record: T, filters: DataFilters<T> | undefined): boolean {
  if (filters == null) return true;
  return matchesFilterObject(record, filters as FilterObject);
}
