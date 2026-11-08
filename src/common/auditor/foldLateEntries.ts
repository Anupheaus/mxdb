import { to, type Logger, type Record as MXDBRecord } from '@anupheaus/common';
import { OperationType, type AuditCreatedEntry, type AuditOperation, type AuditUpdateEntry } from './auditor-models';
import { capPathClockMap, latestCoveringWrite, newerPathsIndexOf, PATH_CLOCK_BUILD_LIMIT, pathClockMapOf, recordPathWrite, type PathClockMap } from './pathClocks';
import { applyOp, readAtPath, type PathValue } from './replay';

/** The operation that puts `path` back to what it was: its old value, or removed when it was not there. */
function restoreOpFor(path: string, { isPresent, value }: PathValue): AuditOperation {
  return isPresent ? { type: OperationType.Replace, path, value: Object.clone(value) } : { type: OperationType.Remove, path };
}

/**
 * Applies one late entry to `record`: each op unless a newer folded write covers its path. A newer folded change to a part of
 * a path it writes stays: each such part is read before the entry changes it and put back after the entry. The entry's own
 * clocks are recorded only after all its ops, so its ops are judged against the history before it, as replay applies them.
 * Linear in its ops: one clock lookup per op, and the parts inside each distinct path are looked up once.
 */
function applyLateEntry(
  record: MXDBRecord,
  clocks: PathClockMap,
  newerWithin: (path: string, id: string) => string[],
  { id, ops }: AuditUpdateEntry,
  logger?: Logger,
): void {
  const restores = new Map<string, AuditOperation>();
  const seenPaths = new Set<string>();
  const written: string[] = [];
  for (const op of ops ?? []) {
    const { path } = op;
    // Already applied (a resend of a folded entry), or overwritten by a newer change: last-write-wins keeps the newer one.
    if (latestCoveringWrite(clocks, path) >= id) continue;
    if (!seenPaths.has(path)) {
      seenPaths.add(path);
      for (const newerPath of newerWithin(path, id)) {
        if (!restores.has(newerPath)) restores.set(newerPath, restoreOpFor(newerPath, readAtPath(record, newerPath)));
      }
    }
    applyOp(record, op, logger);
    written.push(path);
  }
  for (const restore of restores.values()) applyOp(record, restore, logger);
  for (const path of written) recordPathWrite(clocks, { path, id });
}

/**
 * Merges changes a device made before the entries a compaction folded away (it was offline, or is syncing a backlog) into
 * the compacted audit's snapshot, as if those entries were still there: each operation is applied unless a newer folded
 * write covers its path, so last-write-wins holds path by path and a change is only ever lost to a newer one. Entries older
 * than the start of the record's history are dropped, as `ServerReceiver` drops them after an audit reset.
 *
 * Returns a new snapshot (its id unchanged, so every later entry still sorts after it); `snapshot` is not modified.
 */
export function foldLateEntries<RecordType extends MXDBRecord>(
  snapshot: AuditCreatedEntry<RecordType>,
  lateEntries: AuditUpdateEntry[],
  logger?: Logger,
): AuditCreatedEntry<RecordType> {
  const { compaction: startingCompaction } = snapshot;
  if (startingCompaction == null || lateEntries.length === 0) return snapshot;
  const record = Object.clone(snapshot.record);
  const oldestFirst = [...lateEntries].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  // Late entries are applied oldest first, so a clock one of them adds is never newer than a later one: only the snapshot's
  // own clocks can be newer parts of a path, and they are indexed once.
  const newerWithin = newerPathsIndexOf(startingCompaction.clocks);
  let clocks = pathClockMapOf(startingCompaction.clocks);
  for (const entry of oldestFirst) {
    if (entry.id < startingCompaction.historyStart) continue;
    applyLateEntry(record, clocks, newerWithin, entry, logger);
    if (clocks.size > PATH_CLOCK_BUILD_LIMIT) clocks = pathClockMapOf(capPathClockMap(clocks, record));
  }
  // Op values are stored JSON-safe (dates as ISO strings): revive them as replay does.
  return {
    ...snapshot,
    record: to.deserialise<RecordType>(to.serialise(record)),
    compaction: { ...startingCompaction, clocks: capPathClockMap(clocks, record) },
  };
}
