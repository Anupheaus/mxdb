import { is, type DataFilters } from '@anupheaus/common';

/** Logical operators whose value is a list of whole filters (branches). */
const LOGICAL_OPERATORS = new Set(['$or', '$and', '$nor']);

/** Operators that compare against one value: with no value they test for a missing (`$eq`) or present (`$ne`) field. */
const EQUALITY_OPERATORS = new Set(['$eq', '$ne']);

/** Operators whose value is a list of values; a missing value in the list stands for a missing field. */
const LIST_OPERATORS = new Set(['$in', '$nin', '$ni', '$all']);

/** Marks a field condition that has nothing left to test (every bound unset), so it is left out altogether. */
const NO_CONDITION = Symbol('NoCondition');

type FilterObject = { [key: string]: unknown };

/** Stands a missing value in for "the field is missing": `null`, which every query engine reads as null or missing. */
function toMissing(value: unknown): unknown {
  return value === undefined ? null : value;
}

function normaliseOperators(source: FilterObject): FilterObject | typeof NO_CONDITION {
  const result: FilterObject = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('$')) {
      // A nested field path: the same rule as a top-level field.
      const nested = normaliseFieldValue(value);
      if (nested !== NO_CONDITION) result[key] = nested;
      continue;
    }
    if (EQUALITY_OPERATORS.has(key)) { result[key] = toMissing(value); continue; }
    if (key === '$elemMatch' && is.plainObject(value)) { result[key] = normaliseFilters(value); continue; }
    if (LIST_OPERATORS.has(key) && Array.isArray(value)) { result[key] = value.map(toMissing); continue; }
    // An unset range or text bound ($gte, $like, …) narrows nothing — it was never a key lookup — so it stays out.
    if (value !== undefined) result[key] = value;
  }
  const hadConditions = Object.keys(source).length > 0;
  return hadConditions && Object.keys(result).length === 0 ? NO_CONDITION : result;
}

function normaliseFieldValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(toMissing); // a bare array is shorthand for $in
  // Dates, DateTimes, RegExps and other class instances are values to compare, not nested conditions.
  if (!is.plainObject(value)) return value;
  return normaliseOperators(value);
}

function normaliseFilters(filters: FilterObject): FilterObject {
  const result: FilterObject = {};
  for (const [key, value] of Object.entries(filters)) {
    if (LOGICAL_OPERATORS.has(key) && Array.isArray(value)) {
      result[key] = value.map(branch => (is.plainObject(branch) ? normaliseFilters(branch) : branch));
      continue;
    }
    const normalised = normaliseFieldValue(value);
    if (normalised !== NO_CONDITION) result[key] = normalised;
  }
  return result;
}

/**
 * Makes a condition written with no value (`{ leadId: undefined }`) mean "match records where that field is missing",
 * by writing it as `null`, rather than being dropped as if it were never written.
 *
 * Dropping it turned a lookup by a missing key into a read of every record in the collection (Vision sc-2518), and the
 * server could not tell it from a deliberate read of everything, because JSON leaves an `undefined` key out of a client's
 * request altogether. `null` survives the trip, and SQLite (`IS NULL`), sift and MongoDB all read it as "null or missing".
 *
 * Applies to field conditions at any depth (nested paths, `$or` / `$and` / `$nor` branches, `$elemMatch`), to `$eq` /
 * `$ne`, and to a missing value inside a list (`$in`, `$nin`, `$all`, a bare array). An unset range or text bound
 * (`{ start: { $gte: undefined } }`) still narrows nothing, as before; a field left with no condition at all is left out.
 * No filters, or `{}`, still read every record. Returns new objects; the filters given are never changed.
 */
export function matchMissingForEmptyValues<T extends object>(filters: DataFilters<T>): DataFilters<T>;
export function matchMissingForEmptyValues<T extends object>(filters: DataFilters<T> | undefined): DataFilters<T> | undefined;
export function matchMissingForEmptyValues<T extends object>(filters: DataFilters<T> | undefined): DataFilters<T> | undefined {
  if (filters == null) return filters;
  return normaliseFilters(filters as FilterObject) as DataFilters<T>;
}
