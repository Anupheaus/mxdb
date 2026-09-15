import { DateTime } from 'luxon';
import type { AnyObject, DataFilters } from '@anupheaus/common';

type SiftQuery = Record<string, unknown>;

// Positive operators whose null/missing behaviour matches SQL's (a missing/null field fails the match in both).
// Negative operators ($ne / $ni / $nin / $exists) diverge under SQL's 3-valued NULL logic — SQL excludes
// null/missing rows from the match while sift includes them — and string/array/regex operators aren't reproduced
// here yet. Any operator outside this set makes the whole filter fall back to the worker/SQL path.
const SUPPORTED_OPERATORS = new Set(['$eq', '$in', '$gt', '$gte', '$lt', '$lte']);

/** Luxon DateTimes can't be ordered by sift (it only understands JS Date via getTime), so normalise them. */
function normaliseValue(value: unknown): unknown {
  if (DateTime.isDateTime(value)) return value.toJSDate();
  if (Array.isArray(value)) return value.map(normaliseValue);
  return value;
}

/** Translate an operator/nested object for `field`. Returns false when it contains an unsupported operator. */
function translateOperators(field: string, source: Record<string, unknown>, out: SiftQuery): boolean {
  const operators: SiftQuery = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!key.startsWith('$')) {
      // A nested field path alongside/inside this object — recurse into the child path (dot notation).
      if (!walk(`${field}.${key}`, value, out)) return false;
      continue;
    }
    if (!SUPPORTED_OPERATORS.has(key)) return false;
    if (key === '$eq' && value === null) return false; // SQL `= NULL` never matches; sift $eq null matches null — diverges
    if (key === '$in') operators.$in = (Array.isArray(value) ? value : [value]).map(normaliseValue);
    else operators[key] = normaliseValue(value);
  }
  if (Object.keys(operators).length > 0) out[field] = operators;
  return true;
}

/** Translate a single field's value into a sift condition on `out`. Returns false when unsupported. */
function walk(field: string, value: unknown, out: SiftQuery): boolean {
  if (value === undefined) return true;
  if (value === null) { out[field] = null; return true; } // sift {field:null} matches null/missing, like SQL IS NULL
  if (Array.isArray(value)) { out[field] = { $in: value.map(normaliseValue) }; return true; } // bare array ⇒ $in
  if (DateTime.isDateTime(value) || value instanceof Date) { out[field] = normaliseValue(value); return true; }
  if (typeof value !== 'object' || value instanceof RegExp) { out[field] = value; return true; } // primitive equality
  return translateOperators(field, value as Record<string, unknown>, out);
}

/** Translate a filter object (a top-level filter or an $or/$and branch) onto `out`. Returns false when unsupported. */
function walkFilters(filters: Record<string, unknown>, out: SiftQuery): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    if (key === '$or' || key === '$and') {
      const branches: SiftQuery[] = [];
      for (const branch of value as Record<string, unknown>[]) {
        const branchQuery: SiftQuery = {};
        if (!walkFilters(branch, branchQuery)) return false;
        branches.push(branchQuery);
      }
      out[key] = branches;
    } else if (!walk(key, value, out)) {
      return false;
    }
  }
  return true;
}

/** Translate DataFilters into a sift-compatible query (with dot-notation paths and JS-Date-normalised values),
 *  or null when it uses an operator that can't be evaluated in-memory with parity to the worker/SQL path — in
 *  which case the caller should fall back to the worker. */
export function dataFiltersToSift<T extends AnyObject>(filters: DataFilters<T> | undefined): SiftQuery | null {
  if (filters == null) return {};
  const out: SiftQuery = {};
  return walkFilters(filters as Record<string, unknown>, out) ? out : null;
}
