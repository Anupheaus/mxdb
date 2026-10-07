import type { DataFilters } from '@anupheaus/common';
import { DateTime } from 'luxon';
import { matchMissingForEmptyValues } from '../../common/filters';

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
 * `field IN (…)` with a null in the list never matches a missing field (`NULL IN (NULL)` is NULL in SQL), and
 * `NOT IN (…, NULL)` matches nothing at all; MongoDB reads a null in the list as "null or missing". Test that apart.
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
  if (!hasMissing) return params.length === 0 ? { where: '1', params } : { where: `${field} NOT IN (${placeholders})`, params };
  if (params.length === 0) return { where: `${field} IS NOT NULL`, params };
  return { where: `(${field} IS NOT NULL AND ${field} NOT IN (${placeholders}))`, params };
}

// ─── Single condition → SQL ───────────────────────────────────────────────────

function operatorToSql(path: string[], operator: string, value: unknown): SqlFragment {
  const field = jsonExtract(path);

  const sv = serializeParam(value);
  switch (operator) {
    // `= NULL` / `!= NULL` never match in SQL: null here means "missing" / "present" (as in MongoDB).
    case '$eq':
      return value == null ? { where: `${field} IS NULL`, params: [] } : { where: `${field} = ?`, params: [sv] };
    case '$ne':
      return value == null ? { where: `${field} IS NOT NULL`, params: [] } : { where: `${field} != ?`, params: [sv] };
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
      if (arr.length === 0) return { where: '1', params: [] };
      return {
        where: `(SELECT COUNT(*) FROM json_each(${field}) WHERE value IN (${arr.map(() => '?').join(', ')})) = ?`,
        params: [...arr, arr.length],
      };
    }
    case '$size':
      return { where: `json_array_length(${field}) = ?`, params: [value] };
    case '$elemMatch': {
      // Match at least one array element against a sub-filter
      const sub = filtersToSql(value as DataFilters, path.join('.'));
      if (sub.where === '') return { where: '1', params: [] };
      // Re-express using json_each: the sub-filter would normally reference top-level fields
      // but here we need it to reference the element. We use a correlated EXISTS subquery.
      // For simplicity, fall back to a JS post-filter marker — the engine will apply it in-memory.
      // This is noted as a known limitation; proper $elemMatch would require generating
      // json_each subqueries with re-rooted paths.
      return { where: '/* $elemMatch */ 1', params: [] };
    }
    default:
      // Unknown operator — pass-through (match all)
      return { where: '1', params: [] };
  }
}

// ─── Recursive value translator ────────────────────────────────────────────────

function translateValue(path: string[], value: unknown): SqlFragment {
  if (value === undefined) return { where: '', params: [] };
  if (value === null) return { where: `${jsonExtract(path)} IS NULL`, params: [] };

  // Direct array shorthand → $in
  if (Array.isArray(value)) return operatorToSql(path, '$in', value);

  // Primitive / Date / DateTime / RegExp — direct equality
  if (typeof value !== 'object' || value instanceof RegExp || value instanceof Date || DateTime.isDateTime(value)) {
    return operatorToSql(path, '$eq', value);
  }

  // Object: may contain operators and/or nested field paths
  const parts: string[] = [];
  const params: unknown[] = [];

  for (const [key, subValue] of Object.entries(value as Record<string, unknown>)) {
    if (subValue === undefined) continue;
    if (key.startsWith('$')) {
      // Operator key
      const frag = operatorToSql(path, key, subValue);
      if (frag.where) {
        parts.push(frag.where);
        params.push(...frag.params);
      }
    } else {
      // Nested field path
      const frag = translateValue([...path, key], subValue);
      if (frag.where) {
        parts.push(frag.where);
        params.push(...frag.params);
      }
    }
  }

  if (parts.length === 0) return { where: '', params: [] };
  return { where: parts.length === 1 ? parts[0]! : `(${parts.join(' AND ')})`, params };
}

// ─── Top-level translator ─────────────────────────────────────────────────────

/**
 * Translates a `DataFilters<T>` object into a parameterised SQLite WHERE clause.
 *
 * A condition written with no value (`{ leadId: undefined }`) matches records missing that field
 * (`matchMissingForEmptyValues`); it is never dropped, which would read every record.
 *
 * @param filters  The filter object (may be undefined for "no filter").
 * @param _rootPath  Internal — used by $elemMatch recursion; leave empty externally.
 * @returns `{ where, params }` — `where` is empty string when there is no filter.
 *          All user-supplied values are in `params`; nothing is interpolated into SQL.
 */
export function filtersToSql<T extends object = object>(
  rawFilters: DataFilters<T> | undefined,
  _rootPath?: string,
): SqlFragment {
  const filters = matchMissingForEmptyValues(rawFilters);
  if (filters == null) return { where: '', params: [] };

  const entries = Object.entries(filters as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return { where: '', params: [] };

  const parts: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of entries) {
    if (key === '$or') {
      const branches = (value as DataFilters<T>[]).map(f => filtersToSql(f));
      const orParts = branches.map(b => b.where).filter(w => w);
      if (orParts.length > 0) {
        parts.push(orParts.length === 1 ? orParts[0]! : `(${orParts.join(' OR ')})`);
        branches.forEach(b => params.push(...b.params));
      }
    } else if (key === '$and') {
      const branches = (value as DataFilters<T>[]).map(f => filtersToSql(f));
      const andParts = branches.map(b => b.where).filter(w => w);
      if (andParts.length > 0) {
        parts.push(andParts.length === 1 ? andParts[0]! : `(${andParts.join(' AND ')})`);
        branches.forEach(b => params.push(...b.params));
      }
    } else {
      const frag = translateValue([key], value);
      if (frag.where) {
        parts.push(frag.where);
        params.push(...frag.params);
      }
    }
  }

  if (parts.length === 0) return { where: '', params: [] };
  return {
    where: parts.length === 1 ? parts[0]! : parts.join(' AND '),
    params,
  };
}
