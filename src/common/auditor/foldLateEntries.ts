import { to, type Logger, type Record as MXDBRecord } from '@anupheaus/common';
import { OperationType, type AuditCompaction, type AuditCreatedEntry, type AuditOperation, type AuditUpdateEntry } from './auditor-models';
import { capPathClocks, latestCoveringWrite, newerPathsWithin, recordPathWrite } from './pathClocks';
import { applyOp, readAtPath, type PathValue } from './replay';

/** The operation that puts `path` back to what it was: its old value, or removed when it was not there. */
function restoreOpFor(path: string, { isPresent, value }: PathValue): AuditOperation {
  return isPresent ? { type: OperationType.Replace, path, value: Object.clone(value) } : { type: OperationType.Remove, path };
}

/** Applies one operation of a late entry to `record` unless a newer folded write covers it, and returns the clocks after it. */
function applyLateOp(record: MXDBRecord, compaction: AuditCompaction, { id, op }: { id: string; op: AuditOperation }, logger?: Logger): AuditCompaction {
  const { path } = op;
  // Already applied (a resend of a folded entry), or overwritten by a newer change: last-write-wins keeps the newer one.
  if (latestCoveringWrite(compaction, path) >= id) return compaction;
  // A newer folded change to a part of this path stays: put each such part back after the older, wider change.
  const newerParts = newerPathsWithin(compaction, { path, id }).map(newerPath => restoreOpFor(newerPath, readAtPath(record, newerPath)));
  applyOp(record, op, logger);
  for (const restore of newerParts) applyOp(record, restore, logger);
  return { ...compaction, clocks: recordPathWrite(compaction.clocks, { path, id }) };
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
  let compaction = startingCompaction;
  for (const { id, ops } of oldestFirst) {
    if (id < compaction.historyStart) continue;
    for (const op of ops ?? []) compaction = applyLateOp(record, compaction, { id, op }, logger);
  }
  // Op values are stored JSON-safe (dates as ISO strings): revive them as replay does.
  return { ...snapshot, record: to.deserialise<RecordType>(to.serialise(record)), compaction: capPathClocks(compaction, record) };
}
