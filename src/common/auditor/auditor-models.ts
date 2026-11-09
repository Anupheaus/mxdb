import type { Record } from '@anupheaus/common';

// Audit entry type enums
export enum AuditEntryType {
  Created = 0,   // Full initial state
  Updated = 1,   // Partial updates (ops)
  Deleted = 2,   // Soft delete
  Restored = 3,  // Resurrection
  Branched = 4,  // Sync anchor/checkpoint (lean pointer, no record payload)
}

export enum OperationType {
  Remove = 0,
  Replace = 1,
  Move = 2,
  Add = 3,
}

export enum TargetPosition {
  First = 'FIRST',
  Last = 'LAST',
}

/**
 * An operation recorded in an AuditUpdateEntry.
 * Path uses dot-notation with boxed-id anchoring for arrays whose elements have id/_id,
 * and hash-anchored numeric indexing for anonymous array elements.
 */
export interface AuditOperation {
  type: OperationType;
  /** Dot-notation path, e.g. "items.[id:abc].name" or "items.2" */
  path: string;
  value?: unknown;
  /** Used with Move ops to express destination intent */
  position?: TargetPosition;
  /**
   * Anchor Hash: SHA-256 (truncated to 16 hex chars) of the target array element
   * BEFORE the change. Required ONLY when path contains a numeric index.
   */
  hash?: string;
}

/** Shared: entry ULID (time ordering / timestamps are derived via {@link decodeTime} on `id`). */
export interface AuditCommonEntry {
  id: string;
}

export interface AuditCreatedEntry<RecordType extends Record = Record> extends AuditCommonEntry {
  type: AuditEntryType.Created;
  record: RecordType;
  /** Set only on a server audit's first entry when older entries were folded into it (see {@link AuditCompaction}). */
  compaction?: AuditCompaction;
  /**
   * Set only by the server, on the first entry of an audit it started again from the stored record (`upsert(..., { resetAudit:
   * true })`, or a repair of an audit that no longer replays): the history before it was cleared on purpose, so no client
   * entry from before it may change the record (sc-4321). A client never sets it; the receiver drops one a client sends.
   */
  reset?: true;
}

/** The newest entry that wrote a path (or replaced it whole), among the entries a compaction folded away. */
export interface AuditPathClock {
  /** Dot-notation path, as in {@link AuditOperation.path}. */
  path: string;
  /** ULID of the newest folded entry that wrote it. */
  id: string;
}

/**
 * What a compacted audit still knows about the entries folded into its first entry, so a change a device made before
 * them (offline, or a backlog) is still judged last-write-wins against them, path by path, instead of being lost.
 * Server-only: a server audit's history is kept bounded by folding its oldest entries into one `Created` snapshot.
 */
export interface AuditCompaction {
  /** ULID of the `Created` entry the history began with: an entry older than it is dropped, as after an audit reset. */
  historyStart: string;
  /**
   * Per path, the newest folded entry that wrote it. To stay bounded, the oldest clocks are folded into their parent path
   * (coverage only widens inside the part of the record that churned), and a top-level clock for a key the record does not
   * hold is dropped. A path no clock covers was never written by a folded entry that still matters.
   */
  clocks: AuditPathClock[];
}

export interface AuditUpdateEntry extends AuditCommonEntry {
  type: AuditEntryType.Updated;
  ops: AuditOperation[];
}

export interface AuditDeletedEntry extends AuditCommonEntry {
  type: AuditEntryType.Deleted;
}

/**
 * Live row resurrection. If `record` is set, replay materialises that snapshot onto both live and
 * shadow (e.g. restore-to-point-in-time). If omitted, replay copies the current shadow row onto live
 * (undo tombstone while keeping shadow history since delete).
 */
export interface AuditRestoredEntry<RecordType extends Record = Record> extends AuditCommonEntry {
  type: AuditEntryType.Restored;
  record?: RecordType;
}

/** Lean: No record field. Acts as a sync checkpoint pointer. */
export interface AuditBranchedEntry extends AuditCommonEntry {
  type: AuditEntryType.Branched;
}

export type AuditEntry<RecordType extends Record = Record> =
  | AuditCreatedEntry<RecordType>
  | AuditUpdateEntry
  | AuditDeletedEntry
  | AuditRestoredEntry<RecordType>
  | AuditBranchedEntry;


// Same shapes as client entries plus attribution. Not used on the wire to clients as-is.

export interface ServerAuditCommonEntry extends AuditCommonEntry {
  userId: string;
}

export interface ServerAuditCreatedEntry<RecordType extends Record = Record> extends ServerAuditCommonEntry, AuditCreatedEntry<RecordType> { }
export interface ServerAuditUpdateEntry extends ServerAuditCommonEntry, AuditUpdateEntry { }

/** Includes a snapshot of the record at delete time (client `AuditDeletedEntry` has no `record`). */
export interface ServerAuditDeletedEntry<RecordType extends Record = Record> extends ServerAuditCommonEntry, AuditDeletedEntry {
  record: RecordType;
}

export interface ServerAuditRestoredEntry<RecordType extends Record = Record> extends ServerAuditCommonEntry, AuditRestoredEntry<RecordType> { }

export interface ServerAuditBranchedEntry extends ServerAuditCommonEntry, AuditBranchedEntry { }

export type ServerAuditEntry<RecordType extends Record = Record> =
  | ServerAuditCreatedEntry<RecordType>
  | ServerAuditUpdateEntry
  | ServerAuditDeletedEntry<RecordType>
  | ServerAuditRestoredEntry<RecordType>
  | ServerAuditBranchedEntry;

/**
 * Primary audit container for a record. `id` is the live record id; all entries apply to it.
 */
export interface AuditOf<RecordType extends Record = Record> {
  id: string;
  entries: AuditEntry<RecordType>[];
}

/** Server `_sync` document: same as {@link AuditOf} but entries carry `userId` (and delete snapshots). */
export interface ServerAuditOf<RecordType extends Record = Record> {
  id: string;
  entries: ServerAuditEntry<RecordType>[];
}

/** Client {@link AuditOf} or server-persisted {@link ServerAuditOf} (do not strip server fields when round-tripping). */
export type AnyAuditOf<RecordType extends Record = Record> = AuditOf<RecordType> | ServerAuditOf<RecordType>;
