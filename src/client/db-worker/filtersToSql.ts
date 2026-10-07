import type { DataFilters } from '@anupheaus/common';
import { DateTime } from 'luxon';
import { normaliseFilterConditions } from '../../common/filters';

export interface SqlFragment {
  where: string;   // empty string means "no filter"
  params: unknown[];
}

/** Convert a filter value to a type SQLite bind() accepts. */
function serializeParam(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (DateTime.isDateTime(value)) return value.toISO();
  return value;
}

// ─── Field path → json_extract expression ────────────────────────────────────

function jsonExtract(path: string[]): string {
  return `json_extract(data, '$.${path.join('.')}')`;
}

// ─── Lists (which may hold "missing") → SQL ──────────────────────────────────

/**
 * Lists read as MongoDB reads them, which SQL's three-valued NULL logic does not on its own: a null in the list means
 * "null or missing" (`NULL IN (NULL)` is NULL in SQL, and `NOT IN (…, NULL)` matches nothing at all), and a record
 * missing the field IS "not in" a list of values (`NULL NOT IN (…)` is NULL in SQL, so it would be left out).
 */
function listToSql(field: string, values: unknown[], isNegated: boolean): SqlFragment {
  const hasMissing = values.some(value => value == null);
  const params = values.filter(value => value != null).map(serializeParam);
  const placeholders = params.map(() => '?').join(', ');
  if (!isNegated) {
    if (!hasMissing) return params.length === 0 ? { where: '0', params } : { where: `${field} IN (${placeholders})`, params };
    if (params.length === 0) return { where: `${field} IS NULL`, params };
    return { where: `(${field} IN (${placeholders}) OR ${field} IS NULL)`, params };
  }
  if (!hasMissing) return params.length === 0 ? { where: '1', params } : { where: `(${field} IS NULL OR ${field} NOT IN (${placeholders}))`, params };
  if (params.length === 0) return { where: `${field} IS NOT NULL`, params };
  return { where: `(${field} IS NOT NULL AND ${field} NOT IN (${placeholders}))`, params };
}

// ─── Single condition → SQL ───────────────────────────────────────────────────

function operatorToSql(path: string[], operator: string, value: unknown): SqlFragment {
  const field = jsonExtract(path);

  const sv = serializeParam(value);
  switch (operator) {
    // An operand never reaches here null or undefined: normaliseFilterConditions makes such a condition match nothing.
    case '$eq':
      return { where: `${field} = ?`, params: [sv] };
    case '$ne':
      // As in MongoDB, a record missing the field is "not equal" too (`NULL != ?` is NULL in SQL, so it would be left out).
      return { where: `(${field} IS NULL OR ${field} != ?)`, params: [sv] };
    case '$gt':
      return { where: `${field} > ?`, params: [sv] };
    case '$lt':
      return { where: `${field} < ?`, params: [sv] };
    case '$gte':
      return { where: `${field} >= ?`, params: [sv] };
    case '$lte':
      return { where: `${field} <= ?`, params: [sv] };
    case '$like':
      return { where: `${field} LIKE ?`, params: [sv] };
    case '$beginsWith':
      return { where: `${field} LIKE ?`, params: [`${sv}%`] };
    case '$endsWith':
      return { where: `${field} LIKE ?`, params: [`%${sv}`] };
    case '$in':
      return listToSql(field, Array.isArray(value) ? value : [value], false);
    case '$ni':
    case '$nin':
      return listToSql(field, Array.isArray(value) ? value : [value], true);
    case '$exists':
      return value
        ? { where: `${field} IS NOT NULL`, params: [] }
        : { where: `${field} IS NULL`, params: [] };
    case '$regex': {
      const pattern = value instanceof RegExp ? value.source : String(value);
      return { where: `${field} REGEXP ?`, params: [pattern] };
    }
    case '$all': {
      // Every value in the list must appear in the JSON array field
      const arr = (Array.isArray(value) ? value : [value]) as unknown[];
      if (arr.length === 0) return { where: '0', params: [] }; // as in MongoDB: "all of nothing" matches nothing
      return {
        where: `(SELECT COUNT(*) FROM json_each(${field}) WHERE value IN (${arr.map(() => '?').join(', ')})) = ?`,
        params: [...arr, arr.length],
      };
    }
    case '$size':
      return { where: `json_array_length(${field}) = ?`, params: [value] };
    case '$not': {
      // As in MongoDB, a record missing the field is "not" anything: NULL from the inner test counts as no match.
      const inner = value instanceof RegExp ? operatorToSql(path, '$regex', value) : operatorsToSql(path, value as Record<string, unknown>);
      return { where: `NOT COALESCE(${inner.where}, 0)`, params: inner.params };
    }
    case '$elemMatch':
      // Not translated to SQL yet (sc-2758): the in-memory path answers $elemMatch. Here it matches NOTHING rather
      // than everything, so a query the in-memory path declines can come back short, never wide.
      return MATCH_NOTHING_SQL;
    default:
      // normaliseFilterConditions lets no other operator through; never read one as "everything".
      return MATCH_NOTHING_SQL;
  }
}

// ─── Recursive translators ────────────────────────────────────────────────────
//
// Every translator returns a condition that is never empty: an empty filter is `1` (true), never a dropped clause, so
// nothing can disappear on the way into a $or / $nor / $not and change what it means.

/** SQL for a condition no record meets. */
const MATCH_NOTHING_SQL: SqlFragment = { where: '0', params: [] };

/** SQL for "no condition". */
const MATCH_EVERYTHING_SQL: SqlFragment = { where: '1', params: [] };

function combine(fragments: SqlFragment[], joiner: 'AND' | 'OR', whenNone: SqlFragment): SqlFragment {
  if (fragments.length === 0) return whenNone;
  if (fragments.length === 1) return fragments[0]!;
  return { where: `(${fragments.map(({ where }) => where).join(` ${joiner} `)})`, params: fragments.flatMap(({ params }) => params) };
}

function operatorsToSql(path: string[], operators: Record<string, unknown>): SqlFragment {
  return combine(Object.entries(operators).map(([operator, operand]) => operatorToSql(path, operator, operand)), 'AND', MATCH_NOTHING_SQL);
}

function translateValue(path: string[], value: unknown): SqlFragment {
  if (value == null) return { where: `${jsonExtract(path)} IS NULL`, params: [] };

  // Direct array shorthand → $in
  if (Array.isArray(value)) return operatorToSql(path, '$in', value);

  // Primitive / Date / DateTime — direct equality
  if (typeof value !== 'object' || value instanceof Date || DateTime.isDateTime(value)) return operatorToSql(path, '$eq', value);

  // Object: operators, or nested field paths (normaliseFilterConditions never mixes them, nor leaves one empty)
  const entries = Object.entries(value as Record<string, unknown>);
  const fragments = entries.map(([key, subValue]) => (key.startsWith('$') ? operatorToSql(path, key, subValue) : translateValue([...path, key], subValue)));
  return combine(fragments, 'AND', MATCH_NOTHING_SQL);
}

function filterToSql(filters: Record<string, unknown>): SqlFragment {
  const fragments = Object.entries(filters).map(([key, value]): SqlFragment => {
    const branches = () => (value as Record<string, unknown>[]).map(filterToSql);
    switch (key) {
      case '$or': return combine(branches(), 'OR', MATCH_NOTHING_SQL);
      case '$and': return combine(branches(), 'AND', MATCH_EVERYTHING_SQL);
      case '$nor': {
        // NULL from a branch counts as no match, as in MongoDB, so a missing field cannot make the whole $nor NULL.
        const anyBranch = combine(branches(), 'OR', MATCH_NOTHING_SQL);
        return { where: `NOT COALESCE(${anyBranch.where}, 0)`, params: anyBranch.params };
      }
      default: return translateValue([key], value);
    }
  });
  return combine(fragments, 'AND', MATCH_EVERYTHING_SQL);
}

// ─── Top-level translator ─────────────────────────────────────────────────────

/**
 * Translates a `DataFilters<T>` object into a parameterised SQLite WHERE clause.
 *
 * The filters are read by `normaliseFilterConditions` first: a field with no value matches records missing it, and any
 * node it cannot read makes the whole query match nothing. Nothing is ever dropped, which would read every record.
 *
 * @param filters  The filter object (may be undefined for "no filter").
 * @returns `{ where, params }` — `where` is empty string when there is no filter.
 *          All user-supplied values are in `params`; nothing is interpolated into SQL.
 */
export function filtersToSql<T extends object = object>(rawFilters: DataFilters<T> | undefined): SqlFragment {
  const filters = normaliseFilterConditions(rawFilters);
  if (filters == null || Object.keys(filters).length === 0) return { where: '', params: [] };
  return filterToSql(filters as Record<string, unknown>);
}
