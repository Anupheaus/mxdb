import type { AuditCompaction, AuditPathClock } from './auditor-models';

// Clock ids are ULIDs: they sort by time as strings.

/**
 * Most path clocks a compacted audit keeps. A record has a bounded number of fields, but ids added to and removed from its
 * arrays leave a path each; past this many, the oldest are dropped and {@link AuditCompaction.clocksFloor} stands in for them.
 */
export const MAX_AUDIT_PATH_CLOCKS = 500;

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
 * The newest folded write that covers `path`: to the path itself, to a path containing it, or (as `clocksFloor`) one whose
 * clock was dropped. An entry no newer than this was already applied or lost to a newer write.
 */
export function latestCoveringWrite({ clocks, clocksFloor }: AuditCompaction, path: string): string {
  return clocks.reduce((latest, clock) => (isPathWithin(path, clock.path) && clock.id > latest ? clock.id : latest), clocksFloor ?? '');
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

/** How many of `oldestFirst` must go so the rest fit both limits. */
function overLimitCount(oldestFirst: AuditPathClock[], maxClocks: number, maxCharacters: number): number {
  let characters = oldestFirst.reduce((total, { path }) => total + path.length, 0);
  let count = Math.max(0, oldestFirst.length - maxClocks);
  for (let index = 0; index < count; index += 1) characters -= oldestFirst[index]!.path.length;
  while (count < oldestFirst.length && characters > maxCharacters) {
    characters -= oldestFirst[count]!.path.length;
    count += 1;
  }
  return count;
}

/**
 * `compaction` within {@link MAX_AUDIT_PATH_CLOCKS} clocks and {@link MAX_AUDIT_PATH_CLOCK_CHARACTERS} characters of path:
 * the oldest go, and the floor rises to the newest of them.
 */
export function capPathClocks(compaction: AuditCompaction, maxClocks = MAX_AUDIT_PATH_CLOCKS, maxCharacters = MAX_AUDIT_PATH_CLOCK_CHARACTERS): AuditCompaction {
  const { clocks, clocksFloor } = compaction;
  const oldestFirst = [...clocks].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const dropCount = overLimitCount(oldestFirst, maxClocks, maxCharacters);
  if (dropCount === 0) return compaction;
  const dropped = oldestFirst.slice(0, dropCount);
  const newestDropped = dropped[dropped.length - 1]!.id;
  return { ...compaction, clocks: oldestFirst.slice(dropped.length), clocksFloor: clocksFloor != null && clocksFloor > newestDropped ? clocksFloor : newestDropped };
}
