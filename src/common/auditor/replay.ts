import { to, type Logger, type Record as MXDBRecord } from '@anupheaus/common';
import {
  AuditEntryType,
  TargetPosition,
  type AuditEntry,
  type AuditOperation,
  type AuditCreatedEntry,
  type AuditUpdateEntry,
  type AuditRestoredEntry,
} from './auditor-models';
import { contentHash } from './hash';

// ─── Path resolution helpers ──────────────────────────────────────────────────

/**
 * Keys a path may never walk through: reading or writing them reaches an object's prototype (`__proto__.x` would set `x` on
 * every object in the process). Paths come from devices, so this is a whitelist boundary, not a convenience.
 */
const FORBIDDEN_PATH_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parse an audit path string into segments. A path that names a forbidden key ({@link FORBIDDEN_PATH_KEYS}) parses to no
 * segments, so every reader and writer (replay, merge, compaction) treats it as leading nowhere and ignores it.
 */
export function parsePath(path: string): (string | number)[] {
  if (!path) return [];
  const segments: (string | number)[] = [];
  for (const seg of path.split('.')) {
    if (FORBIDDEN_PATH_KEYS.has(seg)) return [];
    if (/^\[_?id:.+\]$/.test(seg)) {
      segments.push(seg); // boxed-id, kept as-is
      continue;
    }
    const num = Number(seg);
    segments.push(Number.isInteger(num) && seg !== '' ? num : seg);
  }
  return segments;
}

/** A value read at a path: `isPresent` is false when the path leads nowhere (a missing key or array element). */
export interface PathValue {
  isPresent: boolean;
  value?: unknown;
}

/** The value at an audit path in `record`, resolved as replay resolves it (boxed ids and array indexes). */
export function readAtPath(record: unknown, path: string): PathValue {
  const segments = parsePath(path);
  if (segments.length === 0) return path === '' ? { isPresent: true, value: record } : { isPresent: false };
  let current: unknown = record;
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') return { isPresent: false };
    if (Array.isArray(current)) {
      const index = resolveArrayIndex(current, segment);
      if (index == null) return { isPresent: false };
      current = current[index];
      continue;
    }
    const key = String(segment);
    if (!Object.prototype.hasOwnProperty.call(current, key)) return { isPresent: false };
    current = (current as Record<string, unknown>)[key];
  }
  return { isPresent: true, value: current };
}

/** Resolve a segment within an array using boxed-id or hash anchoring. */
export function resolveArrayIndex(arr: unknown[], seg: string | number, hash?: string): number | undefined {
  if (typeof seg === 'number') {
    if (hash == null) return seg < arr.length ? seg : undefined;
    // Hash-anchored: find by content hash
    const idx = arr.findIndex(el => contentHash(el) === hash);
    return idx >= 0 ? idx : undefined;
  }
  // Boxed-id: [id:abc] or [_id:abc]
  const boxed = String(seg).match(/^\[(_?id):(.+)\]$/);
  if (boxed) {
    const field = boxed[1]!;
    const val = boxed[2]!;
    const idx = arr.findIndex(el => el != null && typeof el === 'object' && String((el as Record<string, unknown>)[field]) === val);
    return idx >= 0 ? idx : undefined;
  }
  return undefined;
}

// ─── Replay ───────────────────────────────────────────────────────────────────

export function filterValidEntries<T extends MXDBRecord>(entries: unknown[], logger?: Logger): AuditEntry<T>[] {
  const valid: AuditEntry<T>[] = [];

  for (const e of entries) {
    if (e == null || typeof e !== 'object') continue;
    const entry = e as Partial<AuditEntry<T>>;
    if (typeof entry.id !== 'string') continue;
    if (typeof entry.type !== 'number') continue;
    valid.push(entry as AuditEntry<T>);
  }

  if (valid.length !== entries.length) {
    logger?.warn('[auditor] replay: filtered invalid entries', { removed: entries.length - valid.length, total: entries.length });
  }

  return valid;
}

export function applyOp(record: unknown, op: AuditOperation, logger?: Logger): unknown {
  const rawSegs = parsePath(op.path);
  if (rawSegs.length === 0) {
    logger?.debug('[auditor] ignoring op with empty path');
    return record;
  }

  let parent: unknown = record;
  for (let i = 0; i < rawSegs.length - 1; i++) {
    const seg = rawSegs[i]!;
    if (parent == null || typeof parent !== 'object') {
      logger?.warn('[auditor] applyOp: missing parent — ignoring op', { path: op.path, resolvedTo: rawSegs.slice(0, i).join('.') });
      return record;
    }
    if (Array.isArray(parent)) {
      const idx = resolveArrayIndex(parent, seg, i === rawSegs.length - 2 ? op.hash : undefined);
      if (idx == null) {
        logger?.warn('[auditor] applyOp: cannot resolve array index — ignoring op', { path: op.path, seg: String(seg) });
        return record;
      }
      parent = (parent as unknown[])[idx];
    } else {
      parent = (parent as Record<string, unknown>)[String(seg)];
    }
  }

  const lastSeg = rawSegs[rawSegs.length - 1]!;

  if (parent == null || typeof parent !== 'object') {
    logger?.warn('[auditor] applyOp: missing parent for last segment — ignoring op', { path: op.path });
    return record;
  }

  try {
    if (Array.isArray(parent)) {
      // An Add at the start or end needs no index: do not search the array for it (one entry may add thousands of items).
      const isAddAtEnd = op.type === 3 && (op.position === TargetPosition.First || op.position === TargetPosition.Last || op.position == null);
      const idx = isAddAtEnd ? undefined : resolveArrayIndex(parent, lastSeg, op.hash);
      // 0 = Remove, 1 = Replace, 2 = Move, 3 = Add
      if (op.type === 0) {
        if (idx == null) return record;
        (parent as unknown[]).splice(idx, 1);
      } else if (op.type === 1) {
        if (idx == null) return record;
        (parent as unknown[])[idx] = op.value;
      } else if (op.type === 3) {
        if (op.position === TargetPosition.First) {
          (parent as unknown[]).unshift(op.value);
        } else if (op.position === TargetPosition.Last || op.position == null) {
          (parent as unknown[]).push(op.value);
        } else {
          const insertIdx = idx ?? (parent as unknown[]).length;
          (parent as unknown[]).splice(insertIdx, 0, op.value);
        }
      } else if (op.type === 2) {
        if (idx == null) return record;
        const [item] = (parent as unknown[]).splice(idx, 1);
        if (op.position === TargetPosition.First) {
          (parent as unknown[]).unshift(item);
        } else {
          (parent as unknown[]).push(item);
        }
      }
    } else {
      const key = String(lastSeg);
      if (op.type === 0) {
        delete (parent as Record<string, unknown>)[key];
      } else if (op.type === 1 || op.type === 3) {
        (parent as Record<string, unknown>)[key] = op.value;
      }
    }
  } catch (err) {
    logger?.warn('[auditor] applyOp threw — ignoring op', { path: op.path, error: (err as Error)?.message });
  }

  return record;
}

function applyUpdateEntryToClone<T extends MXDBRecord>(
  record: T,
  entry: AuditUpdateEntry,
  logger?: Logger,
): T {
  const clone = Object.clone(record) as T;
  const ops = entry.ops ?? [];
  for (const op of ops) {
    applyOp(clone, op, logger);
  }
  return clone;
}

/** End state after replaying `entries` in ULID order (see {@link replayHistory}). */
export interface ReplayEndState<T extends MXDBRecord> {
  /** Semantic live row (undefined while tombstoned until {@link AuditEntryType.Restored}). */
  live: T | undefined;
  /**
   * Shadow row: same as live when live is set; after {@link AuditEntryType.Deleted}, keeps advancing
   * with {@link AuditEntryType.Updated} so a later Restored can copy it back to live.
   */
  shadow: T | undefined;
}

export function replayHistoryEndState<T extends MXDBRecord>(
  entries: AuditEntry<T>[],
  baseRecord: T | undefined,
  logger?: Logger,
): ReplayEndState<T> {
  const clean = filterValidEntries<T>(entries as unknown as unknown[], logger);
  // Audit entries are appended in ULID-monotonic order in the common case; avoid
  // the O(n log n) sort + array copy when entries are already in order.
  let needsSort = false;
  for (let i = 1; i < clean.length; i++) {
    if (clean[i]!.id < clean[i - 1]!.id) { needsSort = true; break; }
  }
  const sorted = needsSort ? [...clean].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : clean;

  let live: T | undefined = baseRecord;
  let shadow: T | undefined = baseRecord;
  let foundBase = baseRecord != null;

  logger?.debug('[auditor] replay start', { entries: sorted.length, hasBaseRecord: baseRecord != null });

  let entryIndex = 0;
  for (const entry of sorted) {
    entryIndex += 1;
    switch (entry.type) {
      case AuditEntryType.Created: {
        const createdRecord = (entry as AuditCreatedEntry<T>).record;
        if (createdRecord == null) {
          logger?.error('[auditor] replay: Created entry missing record payload', { entryId: entry.id, index: entryIndex, total: sorted.length });
        } else {
          logger?.debug('[auditor] replay: Created — resetting live+shadow', { entryId: entry.id, index: entryIndex, hadBase: foundBase });
          const next = Object.clone(createdRecord);
          live = next;
          shadow = next;
          foundBase = true;
        }
        break;
      }
      case AuditEntryType.Branched:
        break;
      case AuditEntryType.Restored: {
        const payload = (entry as AuditRestoredEntry<T>).record;
        if (payload != null) {
          const next = Object.clone(payload);
          live = next;
          shadow = next;
        } else if (shadow != null) {
          live = Object.clone(shadow);
        }
        break;
      }
      case AuditEntryType.Deleted:
        // Only null out live on the first Deleted entry. Subsequent Deleted entries
        // (e.g. two clients both deleting the same record) must not touch shadow —
        // shadow must continue to advance with any later Updated entries so that a
        // future Restored can copy it back to live correctly.
        live = undefined;
        break;
      case AuditEntryType.Updated: {
        if (shadow == null) {
          const opN = (entry as AuditUpdateEntry).ops?.length ?? 0;
          logger?.error('[auditor] replay: Updated entry skipped — no anchor (need Created or baseRecord)', { entryId: entry.id, index: entryIndex, total: sorted.length, ops: opN });
          break;
        }
        shadow = applyUpdateEntryToClone(shadow, entry as AuditUpdateEntry, logger);
        if (live != null) {
          live = applyUpdateEntryToClone(live, entry as AuditUpdateEntry, logger);
        }
        break;
      }
    }
  }

  logger?.debug('[auditor] replay done', { entries: sorted.length, hasLive: live != null, hasShadow: shadow != null });

  // Deserialise the materialised records so rich types (e.g. Luxon DateTime) are
  // restored from their in-memory forms.
  //
  // We pass the record through `to.serialise` before `to.deserialise` because
  // records sourced from Created/Restored entries are preserved by `Object.clone`
  // with live DateTime instances intact.  `to.deserialise` does not guard against
  // existing DateTime objects — it calls `deserialiseObject` on them, which strips
  // all methods and leaves a broken plain object that merely has `isLuxonDateTime:
  // true`.  Pre-serialising via `to.serialise` converts any live DateTimes to ISO
  // strings first, so the subsequent deserialise pass correctly restores them as
  // proper DateTime instances.
  const deserialise = (record: T): T => to.deserialise<T>(to.serialise(record));
  return {
    live: live != null ? deserialise(live) : undefined,
    shadow: shadow != null ? deserialise(shadow) : undefined,
  };
}

export function replayHistory<T extends MXDBRecord>(
  entries: AuditEntry<T>[],
  baseRecord: T | undefined,
  logger?: Logger,
): T | undefined {
  return replayHistoryEndState(entries, baseRecord, logger).live;
}

