import type { DataRequest, Logger, Record, Unsubscribe } from '@anupheaus/common';
import { bind, is, to } from '@anupheaus/common';
import type { DistinctProps, DistinctResults, MXDBCollectionConfig, QueryResults } from '../../../common/models';
import type { MXDBCollectionEvent } from './models';
import { AUDIT_TABLE_SUFFIX, LIVE_TABLE_SUFFIX, q } from './dbs-consts';
import { auditor } from '../../../common';
import type { AuditEntry, AuditOf } from '../../../common';
import { AuditEntryType } from '../../../common';
import type {
  MXDBActiveRecordState,
  MXDBDeletedRecordState,
} from '../../../common/sync-engine';
import { decodeTime, ulid } from 'ulidx';
import type { SqliteWorkerClient } from '../../db-worker/SqliteWorkerClient';
import { filtersToSql } from '../../db-worker/filtersToSql';
import { sortsToSql } from '../../db-worker/sortsToSql';

export interface UpsertConfig {
  auditAction?: 'branched' | 'default';
  branchUlid?: string;
  ifHasHistory?: 'default' | 'doNotUpsert';
}

/** Options for {@link DbCollection.delete}. */
export interface DeleteOptions {
  /**
   * When true, only the live row is removed; no Deleted audit entry is appended.
   * Use before {@link removeAuditTrail} (e.g. server-driven delete) to avoid writing a tombstone that is immediately discarded.
   */
  skipAuditAppend?: boolean;
}

// ─── SQLite row shapes ────────────────────────────────────────────────────────

interface LiveRow { id: string; data: string; }
interface AuditRow { id: string; recordId: string; type: number; timestamp: number; record: string | null; ops: string | null; }

// ─── AuditOf ↔ rows helpers ───────────────────────────────────────────────────

function entriesToRows(recordId: string, entries: AuditEntry[]): AuditRow[] {
  return entries.map(entry => ({
    id: entry.id,
    recordId,
    type: entry.type,
    timestamp: decodeTime(entry.id),
    record: 'record' in entry && entry.record != null ? to.serialise(entry.record as Record) : null,
    ops: 'ops' in entry && entry.ops != null ? JSON.stringify(entry.ops) : null,
  }));
}

function rowsToAuditOf<T extends Record = Record>(recordId: string, rows: AuditRow[]): AuditOf<T> {
  const entries: AuditEntry<T>[] = rows.map(row => {
    const base = { id: row.id, type: row.type };
    if (row.type === AuditEntryType.Created) {
      return { ...base, record: row.record != null ? to.deserialise(row.record) : null } as AuditEntry<T>;
    }
    if (row.type === AuditEntryType.Restored) {
      if (row.record == null) return base as AuditEntry<T>;
      return { ...base, record: to.deserialise(row.record) } as AuditEntry<T>;
    }
    if (row.type === AuditEntryType.Updated) {
      return { ...base, ops: row.ops != null ? JSON.parse(row.ops) : [] } as AuditEntry<T>;
    }
    return base as AuditEntry<T>;
  });
  return { id: recordId, entries };
}

// ─── DbCollection ─────────────────────────────────────────────────────────────

export class DbCollection<RecordType extends Record = Record> {
  constructor(
    worker: SqliteWorkerClient,
    ready: Promise<void>,
    config: MXDBCollectionConfig<RecordType>,
    logger?: Logger,
  ) {
    this.#name = config.name;
    this.#worker = worker;
    this.#records = new Map();
    this.#auditRecords = new Map();
    this.#pendingIds = new Set();
    this.#callbacks = new Set();
    this.#logger = logger;
    this.#loadingPromise = ready.then(() => this.#loadData());
  }

  #name: string;
  #logger: Logger | undefined;
  #worker: SqliteWorkerClient;
  #records: Map<string, RecordType>;
  #auditRecords: Map<string, AuditOf<RecordType>>;
  // Shadow set of record ids whose audit currently has pending changes.
  // Keeps getPendingStatesSync O(pending) instead of O(all records).
  #pendingIds: Set<string>;
  #loadingPromise: Promise<void>;
  #callbacks: Set<(event: MXDBCollectionEvent<RecordType>) => void>;

  public get name() { return this.#name; }

  // ─── Read API (from in-memory cache) ─────────────────────────────────────

  @bind
  public async getAll(): Promise<RecordType[]> {
    await this.#loadingPromise;
    return Array.from(this.#records.values());
  }

  public async get(id: string): Promise<RecordType | undefined>;
  public async get(ids: string[]): Promise<RecordType[]>;
  @bind
  public async get(idOrIds: string | string[]): Promise<RecordType | RecordType[] | undefined> {
    await this.#loadingPromise;
    if (!Array.isArray(idOrIds)) return this.#records.get(idOrIds);
    return idOrIds.map(id => this.#records.get(id)).removeNull();
  }

  public async getAudit(id: string): Promise<AuditOf<RecordType> | undefined>;
  public async getAudit(ids: string[]): Promise<AuditOf<RecordType>[]>;
  @bind
  public async getAudit(idOrIds: string | string[]): Promise<AuditOf<RecordType> | AuditOf<RecordType>[] | undefined> {
    await this.#loadingPromise;
    if (!Array.isArray(idOrIds)) return this.#auditRecords.get(idOrIds);
    return idOrIds.map(id => this.#auditRecords.get(id)).removeNull();
  }

  // ─── Sync access API (for sync-engine callbacks) ─────────────────────────
  //
  // The sync-engine (CD/CR) requires synchronous read/write callbacks. These
  // methods bypass #loadingPromise and operate directly against the in-memory
  // maps. Callers MUST await {@link whenReady} before invoking any sync method.
  // SQLite persistence is fire-and-forget through the worker queue.

  /** Resolve once the initial SQLite load has completed. */
  @bind
  public whenReady(): Promise<void> { return this.#loadingPromise; }

  /** Synchronous read of states for the given record ids. Missing ids are omitted. */
  @bind
  public getStatesSync(recordIds: string[]): Array<MXDBActiveRecordState<RecordType> | MXDBDeletedRecordState> {
    const out: Array<MXDBActiveRecordState<RecordType> | MXDBDeletedRecordState> = [];
    for (const id of recordIds) {
      const audit = this.#auditRecords.get(id);
      if (audit == null) {
        continue;
      }
      const record = this.#records.get(id);
      if (record != null) out.push({ record, audit: audit.entries });
      else out.push({ recordId: id, audit: audit.entries });
    }
    return out;
  }

  /** Synchronous read of every record/audit pair that still has pending (non-branch-only) changes. */
  @bind
  public getPendingStatesSync(): Array<MXDBActiveRecordState<RecordType> | MXDBDeletedRecordState> {
    const out: Array<MXDBActiveRecordState<RecordType> | MXDBDeletedRecordState> = [];
    for (const id of this.#pendingIds) {
      const audit = this.#auditRecords.get(id);
      if (audit == null) continue; // stale entry; shouldn't happen but guard
      const record = this.#records.get(id);
      if (record != null) out.push({ record, audit: audit.entries });
      else out.push({ recordId: id, audit: audit.entries });
    }
    return out;
  }

  /**
   * Synchronous read of every tracked audit, regardless of whether it has pending
   * changes. Used by the CD's onStart sweep: on (re)connect the client pushes its
   * full known state to the server so the SR can seed the SD filter AND detect
   * disparities (e.g. records tombstoned on the server while the client was
   * disconnected). Without this, branch-only records — those received via
   * {@link applyServerWriteSync} and already collapsed — would be invisible to the
   * reconnect handshake, and any server-side deletions that landed during the
   * disconnect window would never reach the client.
   */
  @bind
  public getAllStatesSync(): Array<MXDBActiveRecordState<RecordType> | MXDBDeletedRecordState> {
    const out: Array<MXDBActiveRecordState<RecordType> | MXDBDeletedRecordState> = [];
    for (const audit of this.#auditRecords.values()) {
      const record = this.#records.get(audit.id);
      if (record != null) out.push({ record, audit: audit.entries });
      else out.push({ recordId: audit.id, audit: audit.entries });
    }
    return out;
  }

  /**
   * Apply an active record write coming from the server (CR.onUpdate).
   * Replaces the in-memory record and collapses its audit to a Branched anchor at lastAuditEntryId.
   */
  @bind
  public applyServerWriteSync(record: RecordType, lastAuditEntryId: string): void {
    this.#records.set(record.id, record);
    const branchedAudit = auditor.createBranchFrom<RecordType>(record.id, lastAuditEntryId || ulid());
    this.#auditRecords.set(record.id, branchedAudit);
    this.#pendingIds.delete(record.id); // Branched audit has no pending changes
    void this.#persist([record], [branchedAudit]);
    this.#invokeOnChange({ type: 'upsert', records: [record], auditAction: 'branched' });
  }

  /**
   * Apply multiple active record writes coming from the server (CR.onUpdate) as a single batch.
   *
   * Prefer this over looping {@link applyServerWriteSync} during reconciliation.  All N records
   * are persisted in **one** {@link execBatch} call (one SQLite transaction, one OPFS flush when
   * encrypted) and change subscribers are notified once rather than once per record.
   *
   * Without batching, reconciliation with N records queues N exec-batch messages in the SQLite
   * worker before any query can run. With encryption each flush serialises the entire DB, so
   * N × flush_time easily reaches tens of seconds on a large database.
   */
  @bind
  public batchApplyServerWriteSync(items: Array<{ record: RecordType; lastAuditEntryId: string }>): void {
    if (items.length === 0) return;
    const allRecords: RecordType[] = [];
    const allAudits: AuditOf<RecordType>[] = [];
    for (const { record, lastAuditEntryId } of items) {
      this.#records.set(record.id, record);
      const branchedAudit = auditor.createBranchFrom<RecordType>(record.id, lastAuditEntryId || ulid());
      this.#auditRecords.set(record.id, branchedAudit);
      this.#pendingIds.delete(record.id); // Branched audit has no pending changes
      allRecords.push(record);
      allAudits.push(branchedAudit);
    }
    void this.#persist(allRecords, allAudits);
    this.#invokeOnChange({ type: 'upsert', records: allRecords, auditAction: 'branched' });
  }

  /**
   * Apply a delete coming from the server (CR.onUpdate).
   *
   * Splits the given ids into two buckets:
   *
   * 1. **Audits with pending local changes** — e.g. a local `Updated` entry that the CD has
   *    not yet dispatched when an incoming S2C delete cursor lands. We remove the live row
   *    (server is authoritative on deletion) but PRESERVE the audit so the pending entries
   *    are not silently dropped. The ServerReceiver's `auditor.merge` keeps post-delete
   *    `Updated` entries in the server audit (they change audit length without resurrecting
   *    the record — only `Restored` can resurrect), and the truth oracle records them the
   *    same way. If we wiped the audit here, client-side pending entries would vanish while
   *    the truth oracle still had them → audit length mismatch. These ids are emitted with
   *    `auditAction: 'markAsDeleted'` so `ClientToServerProvider` re-enqueues them and the
   *    CD dispatches the pending entries (as a deleted-state payload) on its next tick.
   *
   * 2. **No pending changes** — branch-only audits or ids we don't know about. The audit
   *    trail is cleared entirely (server is authoritative). Emitted with
   *    `auditAction: 'remove'` (server-driven reconciliation — no C2S enqueue).
   */
  @bind
  public applyServerDeleteSync(recordIds: string[]): void {
    if (recordIds.length === 0) return;
    const fullyRemoved: string[] = [];
    const preservedPending: string[] = [];
    const fullyRemovedAuditIds: string[] = [];
    for (const id of recordIds) {
      const audit = this.#auditRecords.get(id);
      const hadLive = this.#records.delete(id);
      const pending = audit != null ? auditor.hasPendingChanges(audit) : false;
      if (audit != null && pending) {
        // Keep the audit so CD can still push the pending entries to the server.
        if (hadLive || audit != null) preservedPending.push(id);
        continue;
      }
      if (hadLive || audit != null) fullyRemoved.push(id);
      if (audit != null) {
        this.#auditRecords.delete(id);
        this.#pendingIds.delete(id);
        fullyRemovedAuditIds.push(id);
      }
    }
    const liveIdsToDelete = [...fullyRemoved, ...preservedPending];
    if (liveIdsToDelete.length > 0) void this.#deleteLiveRowsOnly(liveIdsToDelete);
    if (fullyRemovedAuditIds.length > 0) void this.#deleteAuditRowsOnly(fullyRemovedAuditIds);
    if (fullyRemoved.length > 0) {
      this.#invokeOnChange({ type: 'remove', ids: fullyRemoved, auditAction: 'remove' });
    }
    if (preservedPending.length > 0) {
      this.#invokeOnChange({ type: 'remove', ids: preservedPending, auditAction: 'markAsDeleted' });
    }
  }

  /**
   * Collapse the in-memory audit for a record to a Branched anchor at the given ULID
   * (CD success path — server has accepted everything up to anchorUlid).
   */
  @bind
  public collapseAuditSync(recordId: string, anchorUlid: string): void {
    const existing = this.#auditRecords.get(recordId);
    if (existing == null) return;
    const collapsed = auditor.collapseToAnchor(existing, anchorUlid);
    this.#auditRecords.set(recordId, collapsed);
    this.#setPendingId(recordId, collapsed);
    void this.#persistAudits([collapsed]);
  }

  // ─── Upsert ───────────────────────────────────────────────────────────────

  public async upsert(record: RecordType, auditAction?: 'default'): Promise<void>;
  public async upsert(record: RecordType, auditAction: 'branched', branchUlid?: string): Promise<void>;
  @bind
  public async upsert(record: RecordType, auditAction: 'default' | 'branched' = 'default', branchUlid?: string): Promise<void> {
    await this.#loadingPromise;
    const oldRecord = this.#records.get(record.id);
    if (auditAction === 'default' && is.deepEqual(oldRecord, record)) return;

    this.#records.set(record.id, record);

    const existingAudit = this.#auditRecords.get(record.id);
    let newAuditRecord: AuditOf<RecordType>;
    if (auditAction === 'branched') {
      const anchorUlid = branchUlid ?? ulid();
      if (existingAudit != null) {
        // Collapse existing audit to the anchor, preserving any pending entries
        // the server hasn't seen yet (e.g. mutations made while offline or
        // between a C2S dispatch and the S2C push arriving).
        newAuditRecord = auditor.collapseToAnchor(existingAudit, anchorUlid) as AuditOf<RecordType>;
      } else {
        newAuditRecord = auditor.createBranchFrom<RecordType>(record.id, anchorUlid);
      }
    } else if (existingAudit != null) {
      // Pass oldRecord directly as the diff baseline. oldRecord is the current in-memory state
      // (which already has all pending audit ops applied). Calling createRecordFrom(audit, oldRecord)
      // would re-apply those ops on top of oldRecord, producing wrong deltas (e.g. duplicate tags).
      newAuditRecord = auditor.updateAuditWith(
        record,
        existingAudit,
        oldRecord ?? undefined,
        this.#logger,
      );
    } else {
      newAuditRecord = auditor.createAuditFrom(record);
    }
    this.#auditRecords.set(record.id, newAuditRecord);
    this.#setPendingId(record.id, newAuditRecord);

    void this.#persist([record], [newAuditRecord]);
    this.#invokeOnChange({ type: 'upsert', records: [record], auditAction });
  }

  // ─── Collapse audit ───────────────────────────────────────────────────────

  @bind
  public async collapseAudit(recordId: string, anchorUlid: string): Promise<void> {
    await this.#loadingPromise;
    const existingAudit = this.#auditRecords.get(recordId);
    if (existingAudit == null) return;
    const newAudit = auditor.collapseToAnchor(existingAudit, anchorUlid);
    this.#auditRecords.set(recordId, newAudit);
    this.#setPendingId(recordId, newAudit);
    this.#persistAudits([newAudit]);
  }

  // ─── Delete (live row + optional audit tombstone) ─────────────────────────
  //
  // Removes the materialised row from memory and the live SQLite table.
  // When {@link DeleteOptions.skipAuditAppend} is false (default), appends a Deleted audit entry
  // for ids that have a local audit — {@link DbCollection} never strips the audit trail here;
  // use {@link removeAuditTrail} for full audit removal (e.g. after server-driven delete).

  public async delete(id: string, options?: DeleteOptions): Promise<boolean>;
  public async delete(ids: string[], options?: DeleteOptions): Promise<boolean>;
  public async delete(record: RecordType, options?: DeleteOptions): Promise<boolean>;
  public async delete(records: RecordType[], options?: DeleteOptions): Promise<boolean>;
  @bind
  public async delete(
    idsOrRecords: string | string[] | RecordType | RecordType[],
    options?: DeleteOptions,
  ): Promise<boolean> {
    await this.#loadingPromise;
    if (!Array.isArray(idsOrRecords)) return this.delete([idsOrRecords].removeNull() as any, options);
    if (idsOrRecords.length === 0) return false;
    const skipAuditAppend = options?.skipAuditAppend === true;
    const idsToDelete: string[] = [];
    const auditsToPersist: AuditOf<RecordType>[] = [];
    for (const idOrRecord of idsOrRecords) {
      const id = is.not.blank(idOrRecord) ? idOrRecord as string : (idOrRecord as RecordType).id;
      if (!skipAuditAppend) {
        const auditRecord = this.#auditRecords.get(id);
        if (auditRecord != null) {
          const deletedAudit = auditor.delete(auditRecord);
          this.#auditRecords.set(id, deletedAudit);
          this.#setPendingId(id, deletedAudit);
          auditsToPersist.push(deletedAudit);
        }
      }
      if (this.#records.has(id)) this.#records.delete(id);
      idsToDelete.push(id);
    }
    await this.#deleteLiveRowsOnly(idsToDelete);
    if (auditsToPersist.length > 0) void this.#persistAudits(auditsToPersist);
    return true;
  }

  /**
   * Drop audit documents for the given record ids (memory + SQLite audit table).
   * Intended for server-driven reconciliation after the live row is already gone.
   */
  @bind
  public async removeAuditTrail(ids: string | string[]): Promise<void> {
    await this.#loadingPromise;
    const idArr = Array.isArray(ids) ? ids : [ids];
    if (idArr.length === 0) return;
    for (const id of idArr) {
      this.#auditRecords.delete(id);
      this.#pendingIds.delete(id);
    }
    await this.#deleteAuditRowsOnly(idArr);
  }

  @bind
  public notifyRemove(ids: string[], auditAction: 'remove' | 'markAsDeleted'): void {
    if (ids.length === 0) return;
    this.#invokeOnChange({ type: 'remove', ids, auditAction });
  }

  // ─── Query (SQL-backed) ───────────────────────────────────────────────────

  @bind
  public async query({ filters, pagination, sorts }: DataRequest<RecordType>): Promise<QueryResults<RecordType>> {
    await this.#loadingPromise;

    const { where, params } = filtersToSql<RecordType>(filters);
    const orderBy = sortsToSql<RecordType>(sorts);
    const liveTable = q(`${this.#name}${LIVE_TABLE_SUFFIX}`);

    // Count total (no pagination)
    const countSql = `SELECT COUNT(*) as cnt FROM ${liveTable}${where ? ` WHERE ${where}` : ''}`;
    const countRows = await this.#worker.query<{ cnt: number; }>(countSql, params);
    const total = countRows[0]?.cnt ?? 0;

    // Fetch page
    let dataSql = `SELECT data FROM ${liveTable}${where ? ` WHERE ${where}` : ''}`;
    if (orderBy) dataSql += ` ORDER BY ${orderBy}`;
    const dataParams: unknown[] = [...params];
    if (pagination) {
      dataSql += ' LIMIT ? OFFSET ?';
      dataParams.push(pagination.limit, pagination.offset ?? 0);
    }

    const rows = await this.#worker.query<{ data: string; }>(dataSql, dataParams);
    const records = rows.map(row => to.deserialise<RecordType>(row.data));

    return { records, total };
  }

  @bind
  public async distinct<Key extends keyof RecordType>({ field, filters, sorts }: DistinctProps<RecordType, Key>): Promise<DistinctResults<RecordType, Key>> {
    await this.#loadingPromise;

    const { where, params } = filtersToSql<RecordType>(filters);
    const orderBy = sortsToSql<RecordType>(sorts);
    const liveTable = q(`${this.#name}${LIVE_TABLE_SUFFIX}`);
    const fieldExpr = `json_extract(data, '$.${String(field)}')`;

    let sql = `SELECT DISTINCT ${fieldExpr} as v FROM ${liveTable}${where ? ` WHERE ${where}` : ''}`;
    if (orderBy) sql += ` ORDER BY ${orderBy}`;

    const rows = await this.#worker.query<{ v: unknown; }>(sql, params);
    return rows.map(r => r.v) as DistinctResults<RecordType, Key>;
  }

  // ─── Clear ────────────────────────────────────────────────────────────────

  @bind
  public async clear(auditAction: 'preserveWithHistory' | 'all' = 'preserveWithHistory'): Promise<void> {
    await this.#loadingPromise;
    if (auditAction === 'preserveWithHistory') {
      const recordIdsToClear = this.#auditRecords.toValuesArray().mapWithoutNull(
        auditRecord => !this.#pendingIds.has(auditRecord.id) ? auditRecord.id : undefined
      );
      recordIdsToClear.forEach(id => {
        this.#records.delete(id);
        this.#auditRecords.delete(id);
        this.#pendingIds.delete(id);
      });
      void this.#deleteRecords(recordIdsToClear, true);
      this.#invokeOnChange({ type: 'clear', ids: recordIdsToClear });
      return;
    }
    const ids = Array.from(this.#records.keys());
    this.#records.clear();
    this.#auditRecords.clear();
    this.#pendingIds.clear();
    void this.#clearAll();
    this.#invokeOnChange({ type: 'clear', ids });
  }

  // ─── Misc ─────────────────────────────────────────────────────────────────

  @bind
  public async count(): Promise<number> {
    await this.#loadingPromise;
    return this.#records.size;
  }

  @bind
  public async exists(id: string): Promise<boolean> {
    await this.#loadingPromise;
    return this.#records.has(id);
  }

  @bind
  public async getAllAudits(): Promise<AuditOf<RecordType>[]> {
    await this.#loadingPromise;
    return this.#auditRecords.toValuesArray();
  }

  @bind
  public async hasPendingAudits(): Promise<boolean> {
    await this.#loadingPromise;
    return this.#pendingIds.size > 0;
  }

  @bind
  public onChange(callback: (event: MXDBCollectionEvent<RecordType>) => void): Unsubscribe {
    this.#callbacks.add(callback);
    return () => this.#callbacks.delete(callback);
  }

  /**
   * Called by Db when another tab writes to this collection (cross-tab reactivity).
   * Reloads the in-memory cache from SQLite and emits a 'reload' event to subscribers.
   */
  @bind
  public async reloadFromWorker(): Promise<void> {
    await this.#loadingPromise;
    await this.#loadData();
    this.#invokeOnChange({ type: 'reload', records: Array.from(this.#records.values()) });
  }

  // ─── Private: change notification ────────────────────────────────────────

  #invokeOnChange(event: MXDBCollectionEvent<RecordType>) {
    this.#callbacks.forEach(callback => callback(event));
  }

  // ─── Private: pending-ids tracking ───────────────────────────────────────

  /** Keep #pendingIds in sync after any audit change for `id`. */
  #setPendingId(id: string, audit: AuditOf<RecordType>): void {
    if (auditor.hasPendingChanges(audit)) {
      this.#pendingIds.add(id);
    } else {
      this.#pendingIds.delete(id);
    }
  }

  // ─── Private: load from SQLite on startup ────────────────────────────────

  async #loadData() {
    const liveTable = q(`${this.#name}${LIVE_TABLE_SUFFIX}`);

    // Load live records
    const liveRows = await this.#worker.query<LiveRow>(`SELECT id, data FROM ${liveTable}`);
    this.#records = new Map(liveRows.map(row => [row.id, to.deserialise<RecordType>(row.data)]));

    const auditTable = q(`${this.#name}${AUDIT_TABLE_SUFFIX}`);
    const auditRows = await this.#worker.query<AuditRow>(`SELECT id, recordId, type, timestamp, record, ops FROM ${auditTable} ORDER BY recordId, id`);
    const grouped = new Map<string, AuditRow[]>();
    for (const row of auditRows) {
      if (!grouped.has(row.recordId)) grouped.set(row.recordId, []);
      grouped.get(row.recordId)!.push(row);
    }
    this.#auditRecords = new Map(
      Array.from(grouped.entries()).map(([recordId, rows]) => [recordId, rowsToAuditOf<RecordType>(recordId, rows)])
    );
    // Rebuild pending-ids index from freshly loaded audits.
    this.#pendingIds.clear();
    for (const audit of this.#auditRecords.values()) {
      if (auditor.hasPendingChanges(audit)) this.#pendingIds.add(audit.id);
    }

    // Remove orphaned live records — those present in _live but absent from _audit.
    // A legitimate record always has an audit entry (Created for local records, Branched
    // for server-synced ones). An orphan has no audit trail and is invisible to the C2S
    // reconnect sweep, so the server can never push a delete cursor for it. Cleaning up
    // here ensures these ghosts don't persist across restarts.
    const orphanIds = liveRows.map(r => r.id).filter(id => !this.#auditRecords.has(id));
    if (orphanIds.length > 0) {
      this.#logger?.warn(`[DbCollection:${this.#name}] Removing ${orphanIds.length} orphaned live record(s) with no audit entry`, { orphanIds });
      for (const id of orphanIds) this.#records.delete(id);
      const deleteStmts = orphanIds.map(id => ({
        sql: `DELETE FROM ${liveTable} WHERE id = ?`,
        params: [id],
      }));
      await this.#worker.execBatch(deleteStmts, this.#name);
    }
  }

  // ─── Private: fire-and-forget SQLite writes ───────────────────────────────

  async #persist(records: RecordType[], auditRecords: AuditOf<RecordType>[]): Promise<void> {
    const liveStmts = records.map(record => ({
      sql: `INSERT OR REPLACE INTO ${q(`${this.#name}${LIVE_TABLE_SUFFIX}`)}(id, data) VALUES (?, ?)`,
      params: [record.id, to.serialise(record)],
    }));
    const auditStmts = auditRecords.flatMap(audit => this.#auditToInsertStatements(audit));

    if (liveStmts.length > 0 || auditStmts.length > 0) {
      await this.#worker.execBatch([...liveStmts, ...auditStmts], this.#name);
    }
  }

  async #persistAudits(auditRecords: AuditOf<RecordType>[]): Promise<void> {
    if (auditRecords.length === 0) return;
    const stmts = auditRecords.flatMap(audit => this.#auditToInsertStatements(audit));
    if (stmts.length > 0) await this.#worker.execBatch(stmts, this.#name);
  }

  /** Convert AuditOf → DELETE old rows + INSERT each audit entry row (transactional). */
  #auditToInsertStatements(audit: AuditOf<RecordType>): Array<{ sql: string; params: unknown[]; }> {
    const auditTable = q(`${this.#name}${AUDIT_TABLE_SUFFIX}`);
    const stmts: Array<{ sql: string; params: unknown[]; }> = [
      { sql: `DELETE FROM ${auditTable} WHERE recordId = ?`, params: [audit.id] },
    ];
    for (const row of entriesToRows(audit.id, audit.entries)) {
      stmts.push({
        sql: `INSERT INTO ${auditTable}(id, recordId, type, timestamp, record, ops) VALUES (?, ?, ?, ?, ?, ?)`,
        params: [row.id, row.recordId, row.type, row.timestamp, row.record, row.ops],
      });
    }
    return stmts;
  }

  async #deleteLiveRowsOnly(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    const liveTable = q(`${this.#name}${LIVE_TABLE_SUFFIX}`);
    await this.#worker.execBatch(
      [{ sql: `DELETE FROM ${liveTable} WHERE id IN (${placeholders})`, params: ids }],
      this.#name,
    );
  }

  async #deleteAuditRowsOnly(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    const auditTable = q(`${this.#name}${AUDIT_TABLE_SUFFIX}`);
    await this.#worker.execBatch(
      [{ sql: `DELETE FROM ${auditTable} WHERE recordId IN (${placeholders})`, params: ids }],
      this.#name,
    );
  }

  async #deleteRecords(ids: string[], removeAudit = false): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    const liveTable = q(`${this.#name}${LIVE_TABLE_SUFFIX}`);
    const stmts: Array<{ sql: string; params: unknown[]; }> = [
      { sql: `DELETE FROM ${liveTable} WHERE id IN (${placeholders})`, params: ids },
    ];
    if (removeAudit) {
      stmts.push({
        sql: `DELETE FROM ${q(`${this.#name}${AUDIT_TABLE_SUFFIX}`)} WHERE recordId IN (${placeholders})`,
        params: ids,
      });
    } else {
      const auditRecords = ids.mapWithoutNull(id => this.#auditRecords.get(id));
      stmts.push(...auditRecords.flatMap(audit => this.#auditToInsertStatements(audit)));
    }
    await this.#worker.execBatch(stmts, this.#name);
  }

  async #clearAll(): Promise<void> {
    await this.#worker.execBatch([
      { sql: `DELETE FROM ${q(`${this.#name}${LIVE_TABLE_SUFFIX}`)}` },
      { sql: `DELETE FROM ${q(`${this.#name}${AUDIT_TABLE_SUFFIX}`)}` },
    ], this.#name);
  }
}
