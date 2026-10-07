import { is } from '@anupheaus/common';
import { DateTime } from 'luxon';

// ─── The whitelist ────────────────────────────────────────────────────────────
//
// A filter MXDB will evaluate is built ONLY from this grammar. Anything not listed here — an operator, an operand
// shape, a key, a value type, a depth — is not readable, and an unreadable filter matches nothing (Vision sc-2518).
//
//   filter      := {} | { (logical | fieldPath): … }          (a plain object; {} means "no condition")
//   logical     := $and | $or | $nor  →  a non-empty list of filters
//   fieldPath   := identifier ( "." identifier )*             (never __proto__ / constructor / prototype)
//   field value := missing (undefined / null) | single value | list of list values (shorthand for $in)
//                | { operator: operand, … }                    (non-empty; every key an operator below)
//   operators   := $eq $ne $gt $gte $lt $lte  → a single value
//                  $in $nin                   → a list of list values (may be empty)
//                  $all                       → a non-empty list of list values
//                  $exists                    → true or false
//                  $regex                     → a pattern string that compiles (no flags)
//                  $not                       → a non-empty operator object (any of the operators above)
//   single value := text | a finite number | true / false | a valid Date | a valid luxon DateTime
//   list value   := a single value | missing (undefined / null, read as "the field is missing")
//
// Deliberately absent (each reads differently on the device and the server, or is not used by any app):
// $elemMatch (sc-2758), $size, $type, $where, $expr, $text, $options and regex flags, RegExp objects (they do not
// survive JSON), nested-object field values (a dotted path on the device, an exact match on the server: sc-2783),
// and MXDB's device-only $ni / $like / $beginsWith / $endsWith.

const LOGICAL_OPERATORS = new Set(['$and', '$or', '$nor']);
const SINGLE_VALUE_OPERATORS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);
const LIST_OPERATORS = new Set(['$in', '$nin']);

/** A path segment: an identifier. Not an array index — SQLite's JSON path reads `tags.0` as a key, MongoDB as an index. */
const FIELD_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Segments that would reach an object's prototype rather than a stored field. */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** How deeply filters and operator objects may nest; deeper is not a query any screen writes. */
const MAX_DEPTH = 8;

/** A field path every engine reads as the same stored field: `name`, `address.city`. */
export function isReadableFieldPath(path: string): boolean {
  return path.split('.').every(segment => FIELD_SEGMENT.test(segment) && !FORBIDDEN_SEGMENTS.has(segment));
}

/** A single value every engine compares the same way. */
function isSingleValue(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (DateTime.isDateTime(value)) return value.isValid;
  if (is.number(value)) return Number.isFinite(value);
  return is.string(value) || is.boolean(value);
}

function isListValue(value: unknown): boolean {
  return value == null || isSingleValue(value);
}

function isList(value: unknown, { allowEmpty }: { allowEmpty: boolean }): boolean {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(isListValue);
}

function isCompilingPattern(value: unknown): boolean {
  if (!is.string(value)) return false;
  try {
    new RegExp(value);
    return true;
  } catch {
    return false; // a pattern that does not compile is not readable — MongoDB would refuse it too
  }
}

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  return is.plainObject(value);
}

function isOperatorObject(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH || !isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([operator, operand]) => isReadableOperand(operator, operand, depth));
}

function isReadableOperand(operator: string, operand: unknown, depth: number): boolean {
  if (SINGLE_VALUE_OPERATORS.has(operator)) return isSingleValue(operand);
  if (LIST_OPERATORS.has(operator)) return isList(operand, { allowEmpty: true });
  switch (operator) {
    case '$all': return isList(operand, { allowEmpty: false });
    case '$exists': return is.boolean(operand);
    case '$regex': return isCompilingPattern(operand);
    case '$not': return isOperatorObject(operand, depth + 1);
    default: return false;
  }
}

function isReadableFieldValue(value: unknown, depth: number): boolean {
  if (value == null || isSingleValue(value)) return true;
  if (Array.isArray(value)) return isList(value, { allowEmpty: true });
  return isOperatorObject(value, depth + 1);
}

function isReadableBranches(branches: unknown, depth: number): boolean {
  return Array.isArray(branches) && branches.length > 0 && branches.every(branch => isFilter(branch, depth + 1));
}

function isFilter(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH || !isPlainObject(value)) return false;
  return Object.entries(value).every(([key, item]) => {
    if (LOGICAL_OPERATORS.has(key)) return isReadableBranches(item, depth);
    return isReadableFieldPath(key) && isReadableFieldValue(item, depth);
  });
}

/**
 * Whether `filters` is built only from MXDB's filter grammar (above). Runs on the raw filter before any engine sees
 * it, on the device and the server alike; `normaliseFilterConditions` makes an unreadable filter match nothing.
 * `undefined` / `null` (no filter at all) is readable and reads every record.
 */
export function isReadableFilter(filters: unknown): boolean {
  if (filters == null) return true;
  return isFilter(filters, 0);
}
