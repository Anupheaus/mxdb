import type { AuditCompaction, AuditPathClock } from './auditor-models';
import { parsePath, readAtPath } from './replay';

// Clock ids are ULIDs: they sort by time as strings.
//
// Paths and their number come from devices, so every function here is linear (times the bounded clock depth) in the clocks
// and ops it is given: clocks live in a Map while they are built, and nothing scans the whole list once per op (sc-4409).

/**
 * Most path clocks a compacted audit keeps. A record has a bounded number of fields, but ids added to and removed from its
 * arrays leave a path each; past this many, the oldest are folded into their parent path (see {@link capPathClocks}).
 */
export const MAX_AUDIT_PATH_CLOCKS = 500;

/**
 * Most characters of path the clocks may hold between them. Paths come from devices, so one with very long paths (crafted,
 * or a deep record) must not be able to grow the audit by them: past this, the oldest clocks go as they do past the count.
 */
export const MAX_AUDIT_PATH_CLOCK_CHARACTERS = 64 * 1_024;

/** Deepest path a clock is kept for: a write deeper than this is clocked at its ancestor this deep (coverage only widens). */
export const MAX_CLOCK_PATH_SEGMENTS = 8;

/** Longest path a clock is kept for: a longer one is clocked at its deepest ancestor that fits (its first key at least). */
export const MAX_CLOCK_PATH_CHARACTERS = 256;

/** Clocks being built or read: path → the newest entry id that wrote it. */
export type PathClockMap = Map<string, string>;

/** The path one level up (`items.[id:a].name` → `items.[id:a]`), or `undefined` for a top-level key. */
function parentPathOf(path: string): string | undefined {
  const lastDot = path.lastIndexOf('.');
  return lastDot > 0 ? path.slice(0, lastDot) : undefined;
}

/** `path` and each path containing it, deepest first. */
function* selfAndAncestorsOf(path: string): Generator<string> {
  let current: string | undefined = path;
  while (current != null) {
    yield current;
    current = parentPathOf(current);
  }
}

/** Whether `path` is `ancestor` itself or lies inside it (`items.[id:a].name` is within `items`). */
export function isPathWithin(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}.`);
}

/**
 * The path a write to `path` is clocked at: the path itself, or its ancestor at most {@link MAX_CLOCK_PATH_SEGMENTS} deep and
 * {@link MAX_CLOCK_PATH_CHARACTERS} long. `undefined` for a path no replay would ever apply (empty, or naming a prototype key).
 */
export function clockPathOf(path: string): string | undefined {
  if (parsePath(path).length === 0) return;
  const segments = path.split('.', MAX_CLOCK_PATH_SEGMENTS);
  let clockPath = segments[0]!;
  for (const segment of segments.slice(1)) {
    if (clockPath.length + 1 + segment.length > MAX_CLOCK_PATH_CHARACTERS) break;
    clockPath = `${clockPath}.${segment}`;
  }
  return clockPath;
}

/** The clocks as a map. */
export function pathClockMapOf(clocks: AuditPathClock[]): PathClockMap {
  const map: PathClockMap = new Map();
  for (const clock of clocks) recordPathWrite(map, clock);
  return map;
}

/** Records a write to `path` by entry `id` (at its clock path): its clock moves on, and is never moved back. */
export function recordPathWrite(clocks: PathClockMap, { path, id }: AuditPathClock): void {
  const clockPath = clockPathOf(path);
  if (clockPath == null) return;
  const existing = clocks.get(clockPath);
  if (existing == null || existing < id) clocks.set(clockPath, id);
}

/**
 * The newest folded write that covers `path`: to the path itself or to a path containing it. An entry no newer than this was
 * already applied or lost to a newer write. Only a clock on the path or one of its ancestors counts, so a folded write can
 * never suppress a change to a part of the record it did not touch.
 */
export function latestCoveringWrite(clocks: PathClockMap, path: string): string {
  const clockPath = clockPathOf(path);
  if (clockPath == null) return '';
  let latest = '';
  for (const candidate of selfAndAncestorsOf(clockPath)) {
    const id = clocks.get(candidate);
    if (id != null && id > latest) latest = id;
  }
  return latest;
}

/**
 * A lookup of the clocks strictly inside a path, built once from `clocks` (each clock is filed under each of its ancestors,
 * at most {@link MAX_CLOCK_PATH_SEGMENTS} of them). `newerWithin(path, id)` gives the paths inside `path` that an entry newer
 * than `id` wrote.
 */
export function newerPathsIndexOf(clocks: AuditPathClock[]): (path: string, id: string) => string[] {
  const byAncestor = new Map<string, AuditPathClock[]>();
  for (const clock of clocks) {
    let ancestor = parentPathOf(clock.path);
    while (ancestor != null) {
      const within = byAncestor.get(ancestor);
      if (within == null) byAncestor.set(ancestor, [clock]); else within.push(clock);
      ancestor = parentPathOf(ancestor);
    }
  }
  return (path, id) => (byAncestor.get(path) ?? []).filter(clock => clock.id > id).map(clock => clock.path);
}

/** The clocks a newer clock on an ancestor already covers, removed: they change no answer, and only take space. */
function withoutCoveredClocks(clocks: PathClockMap): PathClockMap {
  const kept: PathClockMap = new Map();
  for (const [path, id] of clocks) {
    let isCovered = false;
    for (let ancestor = parentPathOf(path); ancestor != null && !isCovered; ancestor = parentPathOf(ancestor)) {
      const ancestorId = clocks.get(ancestor);
      isCovered = ancestorId != null && ancestorId >= id;
    }
    if (!isCovered) kept.set(path, id);
  }
  return kept;
}

const charactersOf = (clocks: AuditPathClock[]): number => clocks.reduce((total, { path }) => total + path.length, 0);
const isWithinLimits = (clocks: AuditPathClock[], maxClocks: number, maxCharacters: number): boolean => clocks.length <= maxClocks && charactersOf(clocks) <= maxCharacters;
const clocksOf = (map: PathClockMap): AuditPathClock[] => Array.from(map, ([path, id]) => ({ path, id }));

/**
 * How many of `oldestFirst` must go so the rest fit both limits, or every one of them when that is not enough (some clocks
 * cannot go, see {@link capPathClocks}).
 */
function overLimitCount(oldestFirst: AuditPathClock[], maxClocks: number, maxCharacters: number): number {
  let characters = charactersOf(oldestFirst);
  let count = Math.max(0, oldestFirst.length - maxClocks);
  for (let index = 0; index < count; index += 1) characters -= oldestFirst[index]!.path.length;
  while (count < oldestFirst.length && characters > maxCharacters) {
    characters -= oldestFirst[count]!.path.length;
    count += 1;
  }
  return count;
}

/**
 * One round of shrinking: the oldest clocks that can go are folded into their parent path, at the newest id among those
 * folded into it, and a top-level clock for a key `record` does not hold (a removed field, or a path that never led anywhere)
 * is dropped. A top-level clock for a key the record holds stays: there are no more of those than the record has keys.
 * Returns `undefined` when nothing could go.
 */
function shrinkOnce(clocks: AuditPathClock[], record: unknown, maxClocks: number, maxCharacters: number): AuditPathClock[] | undefined {
  const oldestFirst = [...clocks].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const canGo = oldestFirst.filter(({ path }) => parentPathOf(path) != null || !readAtPath(record, path).isPresent);
  const going = new Set(canGo.slice(0, Math.max(1, overLimitCount(oldestFirst, maxClocks, maxCharacters))));
  if (going.size === 0) return;
  const next: PathClockMap = new Map();
  for (const clock of oldestFirst) {
    if (!going.has(clock)) { recordPathWrite(next, clock); continue; }
    const parent = parentPathOf(clock.path);
    if (parent != null) recordPathWrite(next, { path: parent, id: clock.id });
  }
  return clocksOf(withoutCoveredClocks(next));
}

/**
 * The clocks within {@link MAX_AUDIT_PATH_CLOCKS} clocks and {@link MAX_AUDIT_PATH_CLOCK_CHARACTERS} characters of path.
 * Rule: a folded write may only suppress a late change on a path it covers. So the oldest clocks are never dropped behind a
 * global floor; each is folded into its parent path (`list.[id:m1]` becomes `list`), which widens coverage only inside the
 * part of the record that churned, and a change elsewhere is still merged. A top-level clock goes only when `record` does not
 * hold that key. A record with more top-level keys than the limit keeps a clock per key: as many as the record itself holds.
 * Each round is O(n log n) and there are at most {@link MAX_CLOCK_PATH_SEGMENTS} + 1 of them (each folds clocks a level up).
 */
export function capPathClockMap(clocks: PathClockMap, record: unknown, maxClocks = MAX_AUDIT_PATH_CLOCKS, maxCharacters = MAX_AUDIT_PATH_CLOCK_CHARACTERS): AuditPathClock[] {
  let capped = clocksOf(withoutCoveredClocks(clocks));
  while (!isWithinLimits(capped, maxClocks, maxCharacters)) {
    const next = shrinkOnce(capped, record, maxClocks, maxCharacters);
    if (next == null) break;
    capped = next;
  }
  return capped;
}

/** `compaction` with its clocks capped (see {@link capPathClockMap}). */
export function capPathClocks(compaction: AuditCompaction, record: unknown, maxClocks = MAX_AUDIT_PATH_CLOCKS, maxCharacters = MAX_AUDIT_PATH_CLOCK_CHARACTERS): AuditCompaction {
  if (isWithinLimits(compaction.clocks, maxClocks, maxCharacters)) return compaction;
  return { ...compaction, clocks: capPathClockMap(pathClockMapOf(compaction.clocks), record, maxClocks, maxCharacters) };
}

/** Past this many clocks while folding, they are capped before the next entry is folded in, so the map stays bounded as it is built. */
export const PATH_CLOCK_BUILD_LIMIT = 4 * MAX_AUDIT_PATH_CLOCKS;
