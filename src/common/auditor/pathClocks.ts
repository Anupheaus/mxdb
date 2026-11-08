import type { AuditCompaction, AuditPathClock } from './auditor-models';
import { readAtPath } from './replay';

// Clock ids are ULIDs: they sort by time as strings.

/**
 * Most path clocks a compacted audit keeps. A record has a bounded number of fields, but ids added to and removed from its
 * arrays leave a path each; past this many, the oldest are folded into their parent path (see {@link capPathClocks}).
 */
export const MAX_AUDIT_PATH_CLOCKS = 500;

/** The path one level up (`items.[id:a].name` → `items.[id:a]`), or `undefined` for a top-level key. */
function parentPathOf(path: string): string | undefined {
  const lastDot = path.lastIndexOf('.');
  return lastDot > 0 ? path.slice(0, lastDot) : undefined;
}

/** Whether `path` is `ancestor` itself or lies inside it (`items.[id:a].name` is within `items`). */
export function isPathWithin(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}.`);
}

/** The clocks after a write to `path` by entry `id`: its own clock moves on, and older clocks inside it are dropped (it now covers them). */
export function recordPathWrite(clocks: AuditPathClock[], { path, id }: AuditPathClock): AuditPathClock[] {
  const existing = clocks.find(clock => clock.path === path);
  if (existing != null && existing.id >= id) return clocks;
  const others = clocks.filter(clock => clock.path !== path && !(isPathWithin(clock.path, path) && clock.id <= id));
  return [...others, { path, id }];
}

/**
 * The newest folded write that covers `path`: to the path itself or to a path containing it. An entry no newer than this was
 * already applied or lost to a newer write. Only a clock on the path or one of its ancestors counts, so a folded write can
 * never suppress a change to a part of the record it did not touch.
 */
export function latestCoveringWrite({ clocks }: AuditCompaction, path: string): string {
  return clocks.reduce((latest, clock) => (isPathWithin(path, clock.path) && clock.id > latest ? clock.id : latest), '');
}

/** The paths inside `path` (not `path` itself) that a folded entry newer than `id` wrote. */
export function newerPathsWithin({ clocks }: AuditCompaction, { path, id }: AuditPathClock): string[] {
  return clocks.filter(clock => clock.path !== path && isPathWithin(clock.path, path) && clock.id > id).map(clock => clock.path);
}

/**
 * Most characters of path the clocks may hold between them. Paths come from devices, so one with very long paths (crafted,
 * or a deep record) must not be able to grow the audit by them: past this, the oldest clocks go as they do past the count.
 */
export const MAX_AUDIT_PATH_CLOCK_CHARACTERS = 64 * 1_024;

const charactersOf = (clocks: AuditPathClock[]): number => clocks.reduce((total, { path }) => total + path.length, 0);
const isWithinLimits = (clocks: AuditPathClock[], maxClocks: number, maxCharacters: number): boolean => clocks.length <= maxClocks && charactersOf(clocks) <= maxCharacters;

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
  const parents = new Map<string, string>();
  for (const { path, id } of going) {
    const parent = parentPathOf(path);
    if (parent == null) continue;
    const current = parents.get(parent);
    if (current == null || id > current) parents.set(parent, id);
  }
  let next = oldestFirst.filter(clock => !going.has(clock));
  for (const [path, id] of parents) next = recordPathWrite(next, { path, id });
  return next;
}

/**
 * `compaction` within {@link MAX_AUDIT_PATH_CLOCKS} clocks and {@link MAX_AUDIT_PATH_CLOCK_CHARACTERS} characters of path.
 * Rule: a folded write may only suppress a late change on a path it covers. So the oldest clocks are never dropped behind a
 * global floor; each is folded into its parent path (`list.[id:m1]` becomes `list`), which widens coverage only inside the
 * part of the record that churned, and a change elsewhere is still merged. A top-level clock goes only when `record` does not
 * hold that key. A record with more top-level keys than the limit keeps a clock per key: as many as the record itself holds.
 */
export function capPathClocks(compaction: AuditCompaction, record: unknown, maxClocks = MAX_AUDIT_PATH_CLOCKS, maxCharacters = MAX_AUDIT_PATH_CLOCK_CHARACTERS): AuditCompaction {
  let { clocks } = compaction;
  if (isWithinLimits(clocks, maxClocks, maxCharacters)) return compaction;
  while (!isWithinLimits(clocks, maxClocks, maxCharacters)) {
    const next = shrinkOnce(clocks, record, maxClocks, maxCharacters);
    if (next == null) break;
    clocks = next;
  }
  return { ...compaction, clocks };
}
