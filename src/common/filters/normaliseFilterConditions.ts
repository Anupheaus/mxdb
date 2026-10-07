import { is, ValidationError, type DataFilters } from '@anupheaus/common';
import { DateTime } from 'luxon';
import { isReadableFilter } from './isReadableFilter';

// ─── The grammar ──────────────────────────────────────────────────────────────
//
// A filter is an object whose keys are logical operators ($and / $or / $nor) or field paths. A field's value is a
// value to compare (equality), a bare list (shorthand for $in), a nested filter (keys are sub-paths) or an operator
// object (every key an operator). Anything else is not a filter MXDB can read the same way everywhere.

/** Logical operators: their operand is a non-empty list of filters. */
const LOGICAL_OPERATORS = new Set(['$or', '$and', '$nor']);

/** Operators whose operand must be a list of values (`$all` a non-empty one). */
const LIST_OPERATORS = new Set(['$in', '$nin', '$ni', '$all']);

/** Operators whose operand is one value to compare. */
const COMPARISON_OPERATORS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);

/** Device-side text operators: their operand must be a string. */
const TEXT_OPERATORS = new Set(['$like', '$beginsWith', '$endsWith']);

type FilterObject = { [key: string]: unknown };

/** Where an unreadable node's error says it was found; the walk does not track paths, it only needs to stop. */
const FILTER_PATH = 'filters';

/**
 * Stops the walk at the first node it cannot read. The error never escapes `normaliseFilterConditions`: it turns the
 * WHOLE query into one that matches nothing, so no broken node can be dropped, negated into "everything" by
 * `$nor` / `$not`, or read differently by each engine.
 */
function unreadable(reason: string): never {
  throw new ValidationError(reason, FILTER_PATH);
}

/**
 * The query no record meets: `{ id: { $in: [] } }`. SQLite (`0`), sift and MongoDB all read it as nothing, and it
 * survives JSON. A new object each time, so no caller can change another's.
 */
function matchNothingFilter(): FilterObject {
  return { id: { $in: [] } };
}

// ─── Values ───────────────────────────────────────────────────────────────────

/** A single value every engine compares the same way: text, a finite number, a boolean, a Date or a DateTime. */
function isScalar(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (DateTime.isDateTime(value)) return value.isValid;
  if (is.number(value)) return Number.isFinite(value);
  return is.string(value) || is.boolean(value);
}

/** A list element: a scalar, or a missing value (`undefined` / `null`, read as "the field is missing"). */
function normaliseListElement(value: unknown): unknown {
  if (value == null) return null;
  return isScalar(value) ? value : unreadable('a list may only hold single values');
}

function normaliseList(operand: unknown, { allowEmpty }: { allowEmpty: boolean }): unknown[] {
  if (!Array.isArray(operand)) return unreadable('a list operator needs a list');
  if (!allowEmpty && operand.length === 0) return unreadable('an empty list here would match everything or nothing by accident');
  return operand.map(normaliseListElement);
}

// ─── Operators ────────────────────────────────────────────────────────────────

function normaliseOperand(operator: string, operand: unknown): unknown {
  if (operand == null) return unreadable(`${operator} has no operand`);
  if (COMPARISON_OPERATORS.has(operator)) return isScalar(operand) ? operand : unreadable(`${operator} needs a single value`);
  if (LIST_OPERATORS.has(operator)) return normaliseList(operand, { allowEmpty: operator !== '$all' });
  if (TEXT_OPERATORS.has(operator)) return is.string(operand) ? operand : unreadable(`${operator} needs text`);
  switch (operator) {
    case '$regex': return is.string(operand) || operand instanceof RegExp ? operand : unreadable('$regex needs a pattern');
    case '$exists': return is.boolean(operand) ? operand : unreadable('$exists needs true or false');
    case '$size': return Number.isInteger(operand) && (operand as number) >= 0 ? operand : unreadable('$size needs a whole number');
    case '$not': return normaliseNot(operand);
    case '$elemMatch': return normaliseElemMatch(operand);
    default: return unreadable(`${operator} is not an operator MXDB knows`);
  }
}

/** `$not` negates an operator object (or a pattern); anything else could negate "nothing" into "everything". */
function normaliseNot(operand: unknown): unknown {
  if (operand instanceof RegExp) return operand;
  if (!is.plainObject(operand) || !isOperatorObject(operand)) return unreadable('$not needs operators to negate');
  return normaliseOperators(operand);
}

/** `$elemMatch` holds either operators for each element (`{ $gt: 5 }`) or a filter over element fields. */
function normaliseElemMatch(operand: unknown): FilterObject {
  if (!is.plainObject(operand) || Object.keys(operand).length === 0) return unreadable('$elemMatch needs a condition');
  return isOperatorObject(operand) ? normaliseOperators(operand) : normaliseFilter(operand, { allowEmpty: false });
}

function isOperatorObject(value: FilterObject): boolean {
  const keys = Object.keys(value);
  const operatorKeys = keys.filter(key => key.startsWith('$'));
  if (operatorKeys.length > 0 && operatorKeys.length < keys.length) return unreadable('operators and fields cannot be mixed in one condition');
  return keys.length > 0 && operatorKeys.length === keys.length;
}

function normaliseOperators(operators: FilterObject): FilterObject {
  return Object.fromEntries(Object.entries(operators).map(([operator, operand]) => [operator, normaliseOperand(operator, operand)]));
}

// ─── Fields and filters ───────────────────────────────────────────────────────

function normaliseFieldValue(value: unknown): unknown {
  if (value === undefined || value === null) return null; // "the field is missing"
  if (Array.isArray(value)) return normaliseList(value, { allowEmpty: true }); // shorthand for $in
  // A bare pattern is MongoDB shorthand for $regex; SQLite would compare it as a value, so say so explicitly.
  if (value instanceof RegExp) return { $regex: value };
  if (isScalar(value)) return value;
  if (!is.plainObject<FilterObject>(value)) return unreadable('a field can only be compared with a single value, a list or conditions');
  if (Object.keys(value).length === 0) return unreadable('a field condition with nothing in it');
  return isOperatorObject(value) ? normaliseOperators(value) : normaliseFilter(value, { allowEmpty: false });
}

function normaliseBranches(operator: string, branches: unknown): FilterObject[] {
  if (!Array.isArray(branches) || branches.length === 0) return unreadable(`${operator} needs a list of filters`);
  return branches.map(branch => (is.plainObject(branch) ? normaliseFilter(branch, { allowEmpty: true }) : unreadable(`${operator} needs a list of filters`)));
}

/**
 * A filter (the query itself, a logical branch, a nested path or an `$elemMatch` filter). An empty filter is "no
 * condition" — every record — which is what a whole query or a branch of a logical operator legitimately means
 * (`{ $and: [request.filters ?? {}, gate] }`), but never what an empty nested path or `$elemMatch` means.
 */
function normaliseFilter(filter: FilterObject, { allowEmpty }: { allowEmpty: boolean }): FilterObject {
  const entries = Object.entries(filter);
  if (!allowEmpty && entries.length === 0) return unreadable('an empty condition');
  return Object.fromEntries(entries.map(([key, value]) => {
    if (LOGICAL_OPERATORS.has(key)) return [key, normaliseBranches(key, value)];
    if (key.startsWith('$')) return unreadable(`${key} is not an operator MXDB knows here`);
    return [key, normaliseFieldValue(value)];
  }));
}

/**
 * The one place MXDB reads a filter, used by the client before a request leaves the hook, by both device query
 * engines (SQLite and the in-memory path) and by the server.
 *
 * First the WHITELIST (`isReadableFilter`) runs on the raw filter: a filter not built only from MXDB's small grammar
 * — an unknown operator, a wrong operand type, a non-object filter, a bad field name, a regex that does not compile or
 * has flags, a depth beyond the limit — matches NOTHING, whatever surrounds it (a negation of an unreadable node is
 * unreadable too). Only then does the walk below read it, failing closed again on anything it cannot read:
 *
 * - A field written with no value (`{ leadId: undefined }` or `null`) means "the field is missing", written as `null`
 *   — which SQLite (`IS NULL`), sift and MongoDB all read as null or missing, and which survives the JSON trip to the
 *   server. A missing value inside a list (`$in: [undefined]`, a bare array) means the same.
 * - Any node it cannot read — an operator with a missing, `null`, wrong-type or empty operand; an operator it does not
 *   know; an empty condition object (`{ field: {} }`, `$elemMatch: {}`); a `$or` / `$and` / `$nor` without a list of
 *   filters; operators and fields mixed in one condition — makes the WHOLE query match nothing, wherever it sits
 *   (under `$and`, `$or`, `$nor`, `$not` or `$elemMatch`). Nothing is dropped, and nothing broken can be negated into
 *   "everything".
 *
 * Want "any value"? Leave the key out. "Unbounded"? Leave the bound out. "Missing"? `{ field: null }`. No filters, or
 * `{}`, still read every record. Returns new objects; the filters given are never changed. Vision sc-2518.
 */
export function normaliseFilterConditions<T extends object>(filters: DataFilters<T>): DataFilters<T>;
export function normaliseFilterConditions<T extends object>(filters: DataFilters<T> | undefined): DataFilters<T> | undefined;
export function normaliseFilterConditions<T extends object>(filters: DataFilters<T> | undefined): DataFilters<T> | undefined {
  if (filters == null) return filters;
  if (!isReadableFilter(filters)) return matchNothingFilter() as DataFilters<T>;
  try {
    if (!is.plainObject(filters)) return unreadable('a filter must be an object');
    return normaliseFilter(filters, { allowEmpty: true }) as DataFilters<T>;
  } catch (error) {
    // Only the walk throws a ValidationError here: anything else is a bug and is not swallowed.
    if (error instanceof ValidationError) return matchNothingFilter() as DataFilters<T>;
    throw error;
  }
}
