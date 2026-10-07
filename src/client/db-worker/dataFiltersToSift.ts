import { DateTime } from 'luxon';
import type { AnyObject, DataFilters } from '@anupheaus/common';
import { normaliseFilterConditions } from '../../common/filters';

type SiftQuery = Record<string, unknown>;

// Positive operators whose null/missing behaviour matches SQL's (a missing/null field fails the match in both).
// Negative operators ($ne / $ni / $nin / $exists), whose null/missing handling the SQL path spells out by hand, and
// string/array/regex operators aren't reproduced here yet. Any operator outside this set makes the whole filter fall
// back to the worker/SQL path.
const SUPPORTED_OPERATORS = new Set(['$eq', '$in', '$gt', '$gte', '$lt', '$lte']);

/** Luxon DateTimes can't be ordered by sift (it only understands JS Date via getTime), so normalise them. */
function normaliseValue(value: unknown): unknown {
  if (DateTime.isDateTime(value)) return value.toJSDate();
  if (Array.isArray(value)) return value.map(normaliseValue);
  return value;
}

/** A list holding "missing" (null) is matched by the worker's own IS NULL branch; it is not reproduced in memory. */
function hasMissingValue(values: unknown[]): boolean {
  return values.some(value => value == null);
}

// Every function here declines (returns false, so the worker/SQL path answers) rather than leave a condition out:
// a condition that silently went missing would widen the result.

/** Sets `out[key]`, declining when another condition already holds that path — overwriting one would drop it. */
function setCondition(out: SiftQuery, key: string, condition: unknown): boolean {
  if (key in out) return false;
  out[key] = condition;
  return true;
}

function isOperatorObject(value: Record<string, unknown>): boolean {
  return Object.keys(value).every(key => key.startsWith('$'));
}

/** `$elemMatch`'s operand: operators for each element (`{ $gt: 5 }`) or a filter over element fields. */
function translateElemMatch(operand: Record<string, unknown>): SiftQuery | null {
  if (isOperatorObject(operand)) return translateOperatorObject(operand);
  const elementQuery: SiftQuery = {};
  return walkFilters(operand, elementQuery) ? elementQuery : null;
}

/** An operator object as sift reads it, or null when it holds an operator not reproduced here. */
function translateOperatorObject(source: Record<string, unknown>): SiftQuery | null {
  const operators: SiftQuery = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === '$elemMatch') {
      const elementQuery = translateElemMatch(value as Record<string, unknown>);
      if (elementQuery == null) return null;
      operators.$elemMatch = elementQuery;
      continue;
    }
    if (!SUPPORTED_OPERATORS.has(key) || value == null) return null;
    if (key === '$in') {
      const values = value as unknown[];
      if (hasMissingValue(values)) return null;
      operators.$in = values.map(normaliseValue);
    }
    else operators[key] = normaliseValue(value);
  }
  return Object.keys(operators).length > 0 ? operators : null;
}

/** Translate an operator or nested-path object for `field`. Returns false when it cannot be reproduced. */
function translateOperators(field: string, source: Record<string, unknown>, out: SiftQuery): boolean {
  if (Object.keys(source).length === 0) return false;
  if (!isOperatorObject(source)) {
    // Nested field paths — recurse into each child path (dot notation).
    return Object.entries(source).every(([key, value]) => !key.startsWith('$') && walk(`${field}.${key}`, value, out));
  }
  const operators = translateOperatorObject(source);
  return operators != null && setCondition(out, field, operators);
}

/** Translate a single field's value into a sift condition on `out`. Returns false when unsupported. */
function walk(field: string, value: unknown, out: SiftQuery): boolean {
  if (value === undefined) return false; // normaliseFilterConditions never leaves one: decline rather than drop it
  if (value === null) return setCondition(out, field, null); // sift {field:null} matches null/missing, like SQL IS NULL
  if (Array.isArray(value)) { // bare array ⇒ $in
    if (hasMissingValue(value)) return false;
    return setCondition(out, field, { $in: value.map(normaliseValue) });
  }
  if (DateTime.isDateTime(value) || value instanceof Date) return setCondition(out, field, normaliseValue(value));
  if (value instanceof RegExp) return false; // normaliseFilterConditions turns it into $regex, which is not reproduced
  if (typeof value !== 'object') return setCondition(out, field, value); // primitive equality
  return translateOperators(field, value as Record<string, unknown>, out);
}

/** Translate a filter (the query, or a logical branch) onto `out`. Returns false when unsupported. */
function walkFilters(filters: Record<string, unknown>, out: SiftQuery): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (key === '$or' || key === '$and' || key === '$nor') {
      if (!Array.isArray(value) || value.length === 0) return false;
      const branches: SiftQuery[] = [];
      for (const branch of value as Record<string, unknown>[]) {
        const branchQuery: SiftQuery = {};
        if (!walkFilters(branch, branchQuery)) return false;
        branches.push(branchQuery);
      }
      if (!setCondition(out, key, branches)) return false;
    } else if (key.startsWith('$') || !walk(key, value, out)) {
      return false;
    }
  }
  return true;
}

/** Translate DataFilters into a sift-compatible query (with dot-notation paths and JS-Date-normalised values),
 *  or null when it uses an operator that can't be evaluated in-memory with parity to the worker/SQL path — in
 *  which case the caller should fall back to the worker. A condition with no value matches records missing that field
 *  and a broken operand matches nothing (`normaliseFilterConditions`), exactly as on the worker/SQL path. */
export function dataFiltersToSift<T extends AnyObject>(rawFilters: DataFilters<T> | undefined): SiftQuery | null {
  const filters = normaliseFilterConditions(rawFilters);
  if (filters == null) return {};
  const out: SiftQuery = {};
  return walkFilters(filters as Record<string, unknown>, out) ? out : null;
}
