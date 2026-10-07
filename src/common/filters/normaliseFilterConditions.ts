import { is, type DataFilters } from '@anupheaus/common';
import { DateTime } from 'luxon';

/** Logical operators: their operand is a list of whole filters (branches). */
const LOGICAL_OPERATORS = new Set(['$or', '$and', '$nor']);

/** Operators whose operand must be a list of values. */
const LIST_OPERATORS = new Set(['$in', '$nin', '$ni', '$all']);

/** Operators that order against one value: a number, string, boolean, Date or DateTime. */
const RANGE_OPERATORS = new Set(['$gt', '$gte', '$lt', '$lte']);

/** Device-side text operators: their operand must be a string. */
const TEXT_OPERATORS = new Set(['$like', '$beginsWith', '$endsWith']);

/** Marks an operand that cannot be trusted, so the whole condition holding it matches nothing. */
const MATCH_NOTHING = Symbol('MatchNothing');

type FilterObject = { [key: string]: unknown };

/**
 * A field condition no record meets (`{ field: { $in: [] } }`). Every engine reads it the same way: SQLite (`0`),
 * sift and MongoDB all match nothing. A new object each time, so no caller can change another's.
 */
function matchNothingCondition(): FilterObject {
  return { $in: [] };
}

/** A whole filter no record meets, standing in for a broken `$or` / `$and` / `$nor`. */
function matchNothingFilter(): FilterObject {
  return { id: matchNothingCondition() };
}

/** A missing value inside a list stands for a missing field: `null`, which every engine reads as null or missing. */
function toMissing(value: unknown): unknown {
  return value === undefined ? null : value;
}

/** A value an ordering operator can compare: never an object, list, null or undefined. */
function isComparable(value: unknown): boolean {
  if (value instanceof Date || DateTime.isDateTime(value)) return true;
  return is.string(value) || is.number(value) || is.boolean(value);
}

/**
 * Whether an operator's operand is one it can be trusted with. Anything else — no operand, `null`, a value of the
 * wrong type — would otherwise be dropped (reading every record) or read differently by each engine.
 */
function isValidOperand(operator: string, operand: unknown): boolean {
  if (operand == null) return false;
  if (LIST_OPERATORS.has(operator)) return Array.isArray(operand) && (operator !== '$all' || operand.length > 0);
  if (RANGE_OPERATORS.has(operator)) return isComparable(operand);
  if (TEXT_OPERATORS.has(operator)) return is.string(operand);
  switch (operator) {
    case '$regex': return is.string(operand) || operand instanceof RegExp;
    case '$exists': return is.boolean(operand);
    case '$size': return is.number(operand);
    case '$elemMatch': return is.plainObject(operand);
    default: return true; // $eq / $ne take any defined value; operators MXDB does not know are MongoDB's to judge
  }
}

function normaliseOperand(operator: string, operand: unknown): unknown {
  if (LIST_OPERATORS.has(operator)) return (operand as unknown[]).map(toMissing);
  if (operator === '$elemMatch') return normaliseFilters(operand as FilterObject);
  return operand;
}

function normaliseOperators(source: FilterObject): FilterObject | typeof MATCH_NOTHING {
  const result: FilterObject = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('$')) {
      result[key] = normaliseFieldValue(value); // a nested field path: the same rules as a top-level field
      continue;
    }
    if (!isValidOperand(key, value)) return MATCH_NOTHING;
    result[key] = normaliseOperand(key, value);
  }
  return result;
}

function normaliseFieldValue(value: unknown): unknown {
  if (value === undefined) return null; // "the field is missing"
  if (Array.isArray(value)) return value.map(toMissing); // a bare array is shorthand for $in
  // Dates, DateTimes, RegExps and other class instances are values to compare, not nested conditions.
  if (!is.plainObject(value)) return value;
  const normalised = normaliseOperators(value);
  return normalised === MATCH_NOTHING ? matchNothingCondition() : normalised;
}

/** A logical operator's branches, or nothing at all when they are missing, empty or not filters. */
function normaliseBranches(branches: unknown): FilterObject[] | typeof MATCH_NOTHING {
  if (!Array.isArray(branches) || branches.length === 0) return MATCH_NOTHING;
  if (!branches.every(branch => is.plainObject(branch))) return MATCH_NOTHING;
  return branches.map(branch => normaliseFilters(branch as FilterObject));
}

function normaliseFilters(filters: FilterObject): FilterObject {
  const result: FilterObject = {};
  const mustAlsoMatch: FilterObject[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (LOGICAL_OPERATORS.has(key)) {
      const branches = normaliseBranches(value);
      if (branches === MATCH_NOTHING) mustAlsoMatch.push(matchNothingFilter());
      else if (key === '$and') mustAlsoMatch.push(...branches);
      else result[key] = branches;
      continue;
    }
    result[key] = normaliseFieldValue(value);
  }
  // $and branches (and the stand-in for a broken logical operator) are gathered so none overwrites another.
  if (mustAlsoMatch.length > 0) result.$and = mustAlsoMatch;
  return result;
}

/**
 * The one place MXDB decides what an empty or broken filter condition means, used by the client before a request
 * leaves the hook, by both device query engines (SQLite and the in-memory path) and by the server. It fails closed:
 *
 * - A field written with no value (`{ leadId: undefined }`) means "the field is missing", written as `null` — which
 *   SQLite (`IS NULL`), sift and MongoDB all read as null or missing, and which survives the JSON trip to the server.
 *   A missing value inside a list (`$in: [undefined]`, a bare array) means the same.
 * - An operator whose operand is missing, `null` or of the wrong type matches NOTHING, never everything: `$in` /
 *   `$nin` / `$all` without a list (and `$all: []`), `$eq` / `$ne` / `$gt` / … with no value, `$exists` without a
 *   boolean, `$size` without a number, `$regex` / `$like` without a pattern, `$elemMatch` without a filter. Write
 *   `{ field: null }` to ask for a missing field; leave a bound out to leave it unbounded.
 * - `$or` / `$and` / `$nor` without a non-empty list of filters match nothing.
 *
 * Dropping such a condition instead turned a lookup by a missing key into a read of every record (Vision sc-2518).
 * No filters, or `{}`, still read every record. Returns new objects; the filters given are never changed.
 */
export function normaliseFilterConditions<T extends object>(filters: DataFilters<T>): DataFilters<T>;
export function normaliseFilterConditions<T extends object>(filters: DataFilters<T> | undefined): DataFilters<T> | undefined;
export function normaliseFilterConditions<T extends object>(filters: DataFilters<T> | undefined): DataFilters<T> | undefined {
  if (filters == null) return filters;
  return normaliseFilters(filters as FilterObject) as DataFilters<T>;
}
