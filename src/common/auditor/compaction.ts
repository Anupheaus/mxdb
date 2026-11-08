import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import { AuditEntryType, type AuditCompaction, type AuditCreatedEntry, type AuditEntry, type AuditPathClock } from './auditor-models';
import { capPathClocks, recordPathWrite } from './pathClocks';
import { replayHistory } from './replay';

/** When a server audit is compacted, and how much of its newest history is kept as separate entries. */
export interface AuditCompactionLimits {
  /** Compact once the audit holds more entries than this. */
  maxEntries: number;
  /** ...or once its entries add up to more characters of JSON than this. */
  maxCharacters: number;
  /** Newest entries kept as they are (at most). */
  retainedEntries: number;
  /** Characters of JSON the kept entries may add up to (at most). */
  retainedCharacters: number;
}

/**
 * The defaults. One write adds one entry, so a record is compacted about every 20 writes and holds 20 to 40 entries; a record
 * whose entries are large (a long text rewritten) holds no more than about 512 KB of them. MongoDB refuses a document over
 * 16 MB, and every write reads and rewrites the whole audit, so it must stay well below that however often the record is written.
 */
export const AUDIT_COMPACTION_LIMITS: AuditCompactionLimits = {
  maxEntries: 40,
  maxCharacters: 512 * 1_024,
  retainedEntries: 20,
  retainedCharacters: 256 * 1_024,
};

/** The result of a compaction: the new entries (a snapshot first) and the entries folded into that snapshot. */
export interface AuditCompactionResult<RecordType extends MXDBRecord = MXDBRecord> {
  entries: AuditEntry<RecordType>[];
  folded: AuditEntry<RecordType>[];
}

const byId = (left: AuditEntry, right: AuditEntry): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/** Size of an entry as stored, in characters of JSON: an estimate of its share of the document, not an exact byte count. */
function sizeOf(entry: AuditEntry): number {
  return JSON.stringify(entry).length;
}

/** Index of the first entry kept as it is: the newest ones that fit both retained limits. */
function retainedStartOf(sizes: number[], { retainedEntries, retainedCharacters }: AuditCompactionLimits): number {
  let start = sizes.length;
  let characters = 0;
  while (start > 0 && sizes.length - start < retainedEntries && characters + sizes[start - 1]! <= retainedCharacters) {
    start -= 1;
    characters += sizes[start]!;
  }
  return start;
}

/** The compaction state carried over from the audit's first entry, or a fresh one for an audit that starts at a plain `Created`. */
function startingCompactionOf({ id, compaction }: AuditCreatedEntry): AuditCompaction {
  return compaction ?? { historyStart: id, clocks: [] };
}

/** The clocks after folding `entries`: each path any of them wrote, at the newest entry that wrote it. */
function clocksAfter(clocks: AuditPathClock[], entries: AuditEntry[]): AuditPathClock[] {
  return entries.reduce((current, entry) => {
    if (entry.type !== AuditEntryType.Updated) return current;
    return (entry.ops ?? []).reduce((next, { path }) => recordPathWrite(next, { path, id: entry.id }), current);
  }, clocks);
}

/**
 * Folds the oldest entries of a server audit into one `Created` snapshot when the audit has outgrown `limits`, so a record
 * written any number of times keeps a bounded history. Replaying the result gives exactly the record replaying the original
 * gives. The snapshot takes the id of the newest entry it replaces (so every kept entry still sorts after it) and keeps, per
 * path, which folded entry last wrote it, so a device's older change can still be merged by last-write-wins (see
 * `foldLateEntries`). Nothing is folded from a `Deleted` or `Restored` entry on: the record's life and death stay as entries.
 *
 * Returns `undefined` when there is nothing to do: the audit is within the limits, does not start with `Created`, or too
 * few of its entries can be folded to make a difference.
 */
export function compactAuditEntries<RecordType extends MXDBRecord>(
  entries: AuditEntry<RecordType>[],
  limits: AuditCompactionLimits = AUDIT_COMPACTION_LIMITS,
  logger?: Logger,
): AuditCompactionResult<RecordType> | undefined {
  const sorted = [...entries].sort(byId);
  const sizes = sorted.map(sizeOf);
  const characters = sizes.reduce((total, size) => total + size, 0);
  if (sorted.length <= limits.maxEntries && characters <= limits.maxCharacters) return;

  const [first] = sorted;
  if (first == null || first.type !== AuditEntryType.Created) return;
  const lifeChangeIndex = sorted.findIndex(({ type }) => type === AuditEntryType.Deleted || type === AuditEntryType.Restored);
  const foldableEnd = lifeChangeIndex < 0 ? sorted.length : lifeChangeIndex;
  const foldEnd = Math.min(retainedStartOf(sizes, limits), foldableEnd);
  // Folding a single entry would only rewrite the snapshot it already is.
  if (foldEnd < 2) return;

  const folded = sorted.slice(0, foldEnd);
  const record = replayHistory(folded, undefined, logger);
  if (record == null) return;
  const starting = startingCompactionOf(first);
  const compaction = capPathClocks({ ...starting, clocks: clocksAfter(starting.clocks, folded.slice(1)) }, record);
  const snapshot: AuditCreatedEntry<RecordType> = { type: AuditEntryType.Created, id: folded[folded.length - 1]!.id, record, compaction };
  return { entries: [snapshot, ...sorted.slice(foldEnd)], folded };
}
