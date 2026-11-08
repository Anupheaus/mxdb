import { is } from '@anupheaus/common';
import { DateTime } from 'luxon';
import { parseLiteralPattern } from './literalPattern';

// ─── The whitelist ────────────────────────────────────────────────────────────
//
// A filter MXDB will evaluate is built ONLY from this grammar. Anything not listed here — an operator, an operand
// shape, a key, a value type, a depth — is not readable, and an unreadable filter matches nothing (Vision sc-2518).
//
//   filter      := {} | { (logical | fieldPath): … }          (a plain object; {} means "no condition")
//   logical     := $and | $or | $nor  →  a non-empty list of filters
//   fieldPath   := identifier ( "." identifier )*             (never __proto__ / constructor / prototype)
//   field value := missing (undefined / null) | single value | list of list values (shorthand for $in — rewritten
//                  to { $in: … } before either engine sees it, since MongoDB alone would read it as "equals this list")
//                | a pattern                                   (the field matches it: shorthand for $regex)
//                | { operator: operand, … }                    (non-empty; every key an operator below)
//                | { fieldPath: field value, … }               (a nested condition: non-empty, no operator keys; each
//                                                              nested field must match, written as dotted paths
//                                                              before either engine sees it — sc-2783)
//   operators   := $eq $ne $gt $gte $lt $lte  → a single value
//                  $in $nin                   → a list of list values (may be empty)
//                  $all                       → a non-empty list of list values
//                  $exists                    → true or false
//                  $regex                     → a literal pattern string (literalPattern.ts: text with optional
//                                               ^ / $ anchors, at most 128 characters), or a pattern
//                  $options                   → '' or 'i' (case-insensitive), only beside a $regex given as text
//                  $not                       → a non-empty operator object (any of the operators here), or a pattern
//   pattern      := a RegExp whose source is a literal pattern and whose flags are none or 'i' (sc-2783: written as
//                   { $regex, $options } before it leaves the device, so it survives the JSON trip to the server)
//                  $elemMatch                 → the field is a list holding at least ONE item that meets either
//                                               an item condition: a non-empty object of item operators, or
//                                               an item filter: a non-empty filter over the item's own fields
//                                               (an object of field paths and logicals; never both kinds of key)
//   item operators := $eq $ne $gt $gte $lt $lte $in $nin $regex $options, as above, and $not over item operators
//   single value := text | a finite number | true / false | a valid Date | a valid luxon DateTime
//   list value   := a single value | missing (undefined / null, read as "the field is missing")
//
// Deliberately absent (each reads differently on the device and the server, or is not used by any app):
// $size, $type, $where, $expr, $text, regex options other than 'i' (m, s, x, u, g, y…), patterns that are not
// literal, a logical inside a nested condition, $exists / $all / $elemMatch on a list ITEM (sc-2758: not needed, and
// an item that is itself a list reads them differently), and MXDB's device-only $ni / $like / $beginsWith / $endsWith.

const LOGICAL_OPERATORS = new Set(['$and', '$or', '$nor']);
const SINGLE_VALUE_OPERATORS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);
const LIST_OPERATORS = new Set(['$in', '$nin']);

/** The operators an `$elemMatch` item condition may hold (sc-2758). */
const ITEM_OPERATORS = new Set([...SINGLE_VALUE_OPERATORS, ...LIST_OPERATORS, '$regex', '$options', '$not']);

/** The pattern options both engines honour alike: none, or case-insensitive (sc-2783). */
export const READABLE_PATTERN_OPTIONS = new Set(['', 'i']);

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

/** A literal pattern (literalPattern.ts): the one `$regex` shape both engines read alike, in linear time. */
function isLiteralPattern(value: unknown): boolean {
  return is.string(value) && parseLiteralPattern(value) != null;
}

/** A RegExp both engines read alike: a literal source, and no flag but 'i' (sc-2783). */
function isReadableRegExp(value: unknown): value is RegExp {
  return value instanceof RegExp && READABLE_PATTERN_OPTIONS.has(value.flags) && parseLiteralPattern(value.source) != null;
}

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  return is.plainObject(value);
}

/** `$options` only beside a `$regex` written as text (a RegExp carries its own flags; MongoDB refuses both at once). */
function hasReadablePatternOptions(operators: { [key: string]: unknown }): boolean {
  return !('$options' in operators) || is.string(operators.$regex);
}

function isOperatorObject(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH || !isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && hasReadablePatternOptions(value) && entries.every(([operator, operand]) => isReadableOperand(operator, operand, depth));
}

function isReadableOperand(operator: string, operand: unknown, depth: number): boolean {
  if (SINGLE_VALUE_OPERATORS.has(operator)) return isSingleValue(operand);
  if (LIST_OPERATORS.has(operator)) return isList(operand, { allowEmpty: true });
  switch (operator) {
    case '$all': return isList(operand, { allowEmpty: false });
    case '$exists': return is.boolean(operand);
    case '$regex': return isLiteralPattern(operand) || isReadableRegExp(operand);
    case '$options': return is.string(operand) && READABLE_PATTERN_OPTIONS.has(operand);
    case '$not': return isReadableRegExp(operand) || isOperatorObject(operand, depth + 1);
    case '$elemMatch': return isItemOperatorObject(operand, depth + 1) || isItemFilter(operand, depth + 1);
    default: return false;
  }
}

/** An `$elemMatch` item condition: item operators only, each with a readable operand. */
function isItemOperatorObject(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH || !isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && hasReadablePatternOptions(value) && entries.every(([operator, operand]) => {
    if (!ITEM_OPERATORS.has(operator)) return false;
    if (operator !== '$not') return isReadableOperand(operator, operand, depth);
    return isReadableRegExp(operand) || isItemOperatorObject(operand, depth + 1);
  });
}

/** An `$elemMatch` item filter: a non-empty filter over the item's fields (a filter has no operator keys but logicals). */
function isItemFilter(value: unknown, depth: number): boolean {
  return isPlainObject(value) && Object.keys(value).length > 0 && isFilter(value, depth);
}

function isReadableFieldValue(value: unknown, depth: number): boolean {
  if (value == null || isSingleValue(value) || isReadableRegExp(value)) return true;
  if (Array.isArray(value)) return isList(value, { allowEmpty: true });
  return isOperatorObject(value, depth + 1) || isNestedCondition(value, depth + 1);
}

/** A nested condition (`{ address: { city: 'Leeds' } }`): non-empty, every key a field path holding a field value. */
function isNestedCondition(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH || !isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([key, item]) => isReadableFieldPath(key) && isReadableFieldValue(item, depth));
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
