import { DateTime } from 'luxon';
import { to, is, type Record as MXDBRecord } from '@anupheaus/common';
import { OperationType, type AuditOperation } from './auditor-models';
import { contentHash } from './hash';

/** Types that are treated as scalars even though typeof === 'object'. */
const richTypes = new Set(['Date', 'RegExp', 'String', 'Number', 'DateTime']);

function isRichType(val: unknown): boolean {
  if (val == null || typeof val !== 'object') return false;
  const name = Object.getPrototypeOf(val)?.constructor?.name;
  return richTypes.has(name);
}

function isTraversable(val: unknown): val is object {
  return val != null && typeof val === 'object' && !isRichType(val);
}

/**
 * Serialise a value to its JSON-safe form for storage in audit ops.
 * Any object (including nested objects and arrays) is round-tripped through
 * `to.serialise` so that rich types (Luxon DateTime, Date, Error) at any depth
 * are converted to their string representations before being stored.
 * Plain scalars are returned as-is.
 */
function toOpValue(val: unknown): unknown {
  if (val == null || typeof val !== 'object') return val;
  return JSON.parse(to.serialise(val));
}

/**
 * Equality check for non-traversable (scalar/rich-type) values.
 * DateTimes are compared by millisecond value so that the same instant in
 * different zones (e.g. UTC vs Europe/London) is treated as equal.
 * All other types delegate to `is.deepEqual`.
 */
function scalarEqual(a: unknown, b: unknown): boolean {
  if (DateTime.isDateTime(a) && DateTime.isDateTime(b)) return a.toMillis() === b.toMillis();
  return is.deepEqual(a, b);
}

/** Returns the boxed-id path segment for an array element, e.g. "[id:abc]", or undefined. */
function getBoxedId(elem: unknown): string | undefined {
  if (elem == null || typeof elem !== 'object' || Array.isArray(elem)) return undefined;
  const e = elem as Record<string, unknown>;
  if (e['id'] != null) return `[id:${e['id']}]`;
  if (e['_id'] != null) return `[_id:${e['_id']}]`;
  return undefined;
}

function joinPath(prefix: string, seg: string): string {
  return prefix ? `${prefix}.${seg}` : seg;
}

/** Diff two plain objects. */
function diffObjects(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  path: string,
  ops: AuditOperation[],
  stack: unknown[],
): void {
  // Keys removed or changed
  for (const key of Object.keys(oldObj)) {
    const segPath = joinPath(path, key);
    if (!(key in newObj)) {
      ops.push({ type: OperationType.Remove, path: segPath });
    } else {
      diffAny(oldObj[key], newObj[key], segPath, ops, stack);
    }
  }
  // Keys added
  for (const key of Object.keys(newObj)) {
    if (!(key in oldObj)) {
      ops.push({ type: OperationType.Add, path: joinPath(path, key), value: toOpValue(newObj[key]) });
    }
  }
}

/** Diff two arrays whose elements have id or _id fields. Match elements by id. */
function diffIdArray(
  oldArr: unknown[],
  newArr: unknown[],
  path: string,
  ops: AuditOperation[],
  stack: unknown[],
): void {
  const oldById = new Map<string, unknown>();
  for (const elem of oldArr) {
    const boxedId = getBoxedId(elem);
    if (boxedId) oldById.set(boxedId, elem);
  }

  const newById = new Map<string, unknown>();
  for (const elem of newArr) {
    const boxedId = getBoxedId(elem);
    if (boxedId) newById.set(boxedId, elem);
  }

  // Removed
  for (const [boxedId] of oldById) {
    if (!newById.has(boxedId)) {
      ops.push({ type: OperationType.Remove, path: joinPath(path, boxedId) });
    }
  }

  // Added
  for (const [boxedId, newElem] of newById) {
    if (!oldById.has(boxedId)) {
      ops.push({ type: OperationType.Add, path: joinPath(path, boxedId), value: toOpValue(newElem) });
    }
  }

  // Changed (recurse into matching elements)
  // Pass stack as-is; diffAny handles cycle detection internally for objects.
  for (const [boxedId, oldElem] of oldById) {
    const newElem = newById.get(boxedId);
    if (newElem !== undefined) {
      diffAny(oldElem, newElem, joinPath(path, boxedId), ops, stack);
    }
  }
}

/** Diff two anonymous arrays (no id fields). Match by index, include content hash for anchoring. */
function diffAnonArray(
  oldArr: unknown[],
  newArr: unknown[],
  path: string,
  ops: AuditOperation[],
  stack: unknown[],
): void {
  const maxLen = Math.max(oldArr.length, newArr.length);
  for (let i = 0; i < maxLen; i++) {
    const segPath = joinPath(path, String(i));
    if (i >= newArr.length) {
      // Removed from end
      ops.push({ type: OperationType.Remove, path: segPath, hash: contentHash(oldArr[i]) });
    } else if (i >= oldArr.length) {
      // Added at end
      ops.push({ type: OperationType.Add, path: segPath, value: toOpValue(newArr[i]) });
    } else {
      const oldElem = oldArr[i];
      const newElem = newArr[i];
      if (isTraversable(oldElem) && isTraversable(newElem) && Array.isArray(oldElem) === Array.isArray(newElem)) {
        // Pass stack as-is; diffAny handles cycle detection internally for objects.
        diffAny(oldElem, newElem, segPath, ops, stack);
      } else if (!scalarEqual(oldElem, newElem)) {
        ops.push({ type: OperationType.Replace, path: segPath, value: toOpValue(newElem), hash: contentHash(oldElem) });
      }
    }
  }
}

export function diffAny(
  oldVal: unknown,
  newVal: unknown,
  path: string,
  ops: AuditOperation[],
  stack: unknown[],
): void {
  if (isTraversable(oldVal) && isTraversable(newVal) && Array.isArray(oldVal) === Array.isArray(newVal)) {
    if (Array.isArray(oldVal)) {
      const newArr = newVal as unknown[];
      // Check if elements are id-bearing by sampling the first non-null element from either array
      const sample = (oldVal as unknown[]).find(e => e != null) ?? newArr.find(e => e != null);
      if (getBoxedId(sample) != null) {
        diffIdArray(oldVal as unknown[], newArr, path, ops, stack);
      } else {
        diffAnonArray(oldVal as unknown[], newArr, path, ops, stack);
      }
    } else {
      if (!stack.includes(oldVal)) {
        diffObjects(
          oldVal as Record<string, unknown>,
          newVal as Record<string, unknown>,
          path,
          ops,
          [...stack, oldVal],
        );
      }
    }
  } else if (!scalarEqual(oldVal, newVal)) {
    ops.push({ type: OperationType.Replace, path, value: toOpValue(newVal) });
  }
}

/** Compute the AuditOperation diff between two records. Returns [] if no changes. */
export function recordDiff<T extends MXDBRecord>(oldRecord: T, newRecord: T): AuditOperation[] {
  const ops: AuditOperation[] = [];
  diffObjects(
    oldRecord as unknown as Record<string, unknown>,
    newRecord as unknown as Record<string, unknown>,
    '',
    ops,
    [oldRecord],
  );
  return ops;
}
