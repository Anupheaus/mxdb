import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import type { MXDBCollection } from '../common';
import { auditor, configRegistry } from '../common';
import { hashRecord } from '../common/auditor/hash';
import {
  ServerDispatcher,
  SyncPausedError,
  type MXDBActiveRecordCursor,
  type MXDBDeletedRecordCursor,
  type MXDBRecordCursors,
  type MXDBSyncEngineResponse,
} from '../common/sync-engine';
import type { ServerDb } from './providers/db/ServerDb';
import { isTransientMongoCloseError } from './utils/isTransientMongoCloseError';

/**
 * Per-connection server→client synchronisation adapter.
 *
 * Owns a single {@link ServerDispatcher} for one connected client and translates
 * between MXDB concepts (audit, hash, ServerDb) and the pure sync-engine cursor
 * model. The SD handles all filter/deletedRecordIds bookkeeping; this class is
 * the impurity boundary that fetches audits, computes hashes, and builds cursors.
 *
 * One instance per connected client. Construct on connect, call {@link close}
 * on disconnect.
 */
export interface ServerToClientSynchronisationProps {
  /** Emits an `mxdbServerToClientSyncAction` to the connected client. */
  emitS2C(payload: MXDBRecordCursors): Promise<MXDBSyncEngineResponse>;
  getDb(): ServerDb;
  collections: MXDBCollection[];
  logger: Logger;
  /** Identifies the connected client (socket id) for diagnostics. */
  clientId?: string;
  /** When true, all outward S2C effects are skipped (server-startup no-op instance). */
  noOp?: boolean;
}

export class ServerToClientSynchronisation {
  readonly #logger: Logger;
  readonly #getDb: (() => ServerDb) | null;
  readonly #collectionNames: Set<string>;
  readonly #disableAuditByCollection: Map<string, boolean>;
  readonly #sd: ServerDispatcher | null;
  readonly #noOp: boolean;
  #closed = false;

  constructor(props: ServerToClientSynchronisationProps) {
    this.#logger = props.logger;
    this.#getDb = props.noOp === true ? null : props.getDb;
    this.#noOp = props.noOp === true;
    this.#collectionNames = new Set(props.collections.map(c => c.name));
    this.#disableAuditByCollection = new Map(
      props.collections.map(c => [c.name, configRegistry.getOrError(c).disableAudit === true]),
    );

    if (this.#noOp) {
      this.#sd = null;
      return;
    }

    this.#sd = new ServerDispatcher(this.#logger.createSubLogger('sd'), {
      clientId: props.clientId,
      onDispatch: async (payload: MXDBRecordCursors): Promise<MXDBSyncEngineResponse> => {
        try {
          return await props.emitS2C(payload);
        } catch (error) {
          // The socket layer surfaces client-side paused state as a plain Error with
          // this sentinel message (SyncPausedError instances cannot cross socket.io).
          if (error instanceof Error && error.message === 'MXDB_SYNC_PAUSED') {
            throw new SyncPausedError();
          }
          const errAny = error as any;
          this.#logger.warn('S2C emitS2C threw (likely client disconnect race)', {
            errorMessage: errAny?.message ?? String(error),
            errorCode: errAny?.code,
            errorName: errAny?.name,
          });
          throw error;
        }
      },
    });
  }

  /**
   * No-op instance used under impersonation / startup seeding so that
   * `useServerToClientSynchronisation()` is always defined without emitting.
   */
  static createNoOp(collections: MXDBCollection[], logger: Logger): ServerToClientSynchronisation {
    return new ServerToClientSynchronisation({
      noOp: true,
      emitS2C: async () => [],
      getDb: () => { throw new Error('ServerToClientSynchronisation no-op: getDb must not be called'); },
      collections,
      logger,
    });
  }

  get isNoOp(): boolean { return this.#noOp; }

  /** Pause the underlying SD (prevents further dispatches until {@link resume}). */
  pause(): void { this.#sd?.pause(); }

  /** Resume the underlying SD. */
  resume(): void { this.#sd?.resume(); }

  /** Access the underlying ServerDispatcher, used by the SR in the C2S action handler. */
  get dispatcher(): ServerDispatcher {
    if (this.#sd == null) throw new Error('ServerToClientSynchronisation: dispatcher unavailable on no-op instance');
    return this.#sd;
  }

  /** Release references; no further emits will occur. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Pause to stop any in-flight retry timer from re-triggering.
    this.#sd?.pause();
  }

  /**
   * Feed a MongoDB change-stream event into the SD.
   *
   * Tombstoned records are filtered OUT here: once a record has been
   * deleted, only the original `Deleted` transition is propagated. Subsequent
   * audit mutations on a tombstoned record never reach the SD.
   *
   * Pushes are dispatched with `addToFilter=false` — change-stream fan-out is
   * not allowed to bootstrap records on the CR. If the client doesn't already
   * know about a record, the SD will drop the cursor.
   */
  async onDbChange(event:
    | { type: 'upsert'; collectionName: string; records: MXDBRecord[] }
    | { type: 'delete'; collectionName: string; recordIds: string[] },
  ): Promise<void> {
    if (this.#noOp || this.#closed || this.#sd == null) return;
    if (!this.#collectionNames.has(event.collectionName)) return;

    if (event.type === 'upsert') {
      await this.#buildAndPush(event.collectionName, event.records, /* addToFilter */ false);
    } else {
      const cursors = await this.#buildDeleteCursors(event.collectionName, event.recordIds);
      if (cursors.length > 0) {
        this.#sd.push([{ collectionName: event.collectionName, records: cursors }], /* addToFilter */ false);
      }
    }
  }

  /**
   * Authoritative push of live records to the CR. Used by getAll / query / get /
   * subscription result paths to deliver records to the client via the SD. On
   * successful dispatch, the SD adds each record to its filter so subsequent
   * change-stream events for the same id can reach the client.
   *
   * Unlike {@link onDbChange}, this path bootstraps records — the CR may have
   * no prior knowledge of the record and the dispatch will still go through.
   */
  async pushActive(collectionName: string, records: MXDBRecord[]): Promise<void> {
    if (this.#noOp || this.#closed || this.#sd == null) return;
    if (!this.#collectionNames.has(collectionName)) return;
    await this.#buildAndPush(collectionName, records, /* addToFilter */ true);
  }

  /**
   * Push explicit delete cursors to the SD — used by reconcile to tell a
   * reconnecting client about records that have been removed while offline.
   * Dispatched as change-stream-style (`addToFilter=false`) so the SD drops
   * deletes for records the CR never knew about.
   */
  async pushDeletes(collectionName: string, recordIds: string[]): Promise<void> {
    if (this.#noOp || this.#closed || this.#sd == null) return;
    if (recordIds.length === 0) return;
    if (!this.#collectionNames.has(collectionName)) return;
    const cursors = await this.#buildDeleteCursors(collectionName, recordIds);
    if (cursors.length > 0) {
      this.#sd.push([{ collectionName, records: cursors }], /* addToFilter */ false);
    }
  }

  // ─── Private: cursor construction ─────────────────────────────────────────

  async #buildAndPush(collectionName: string, records: MXDBRecord[], addToFilter: boolean): Promise<void> {
    if (records.length === 0 || this.#sd == null) return;
    const db = this.#getDb?.();
    if (db == null) return;

    let collection: ReturnType<typeof db.use>;
    try { collection = db.use(collectionName); }
    catch { return; }

    const disableAudit = this.#disableAuditByCollection.get(collectionName) === true;
    const allIds = records.ids();

    // Pair-consistency check — the cursor's `record` and `lastAuditEntryId` MUST
    // reflect the same server state. Uses batch reads (one MongoDB round-trip per
    // step) rather than per-record queries, reducing N×3 queries to 3 total.
    //
    // Step ordering: audit-before → (live + audit-after in parallel). Any write
    // that lands during this window changes audit-after's lastEntryId, which we
    // detect and retry individually.
    let cursors: (MXDBActiveRecordCursor & { hash: string })[];

    if (disableAudit) {
      const freshRecords = await collection.get(allIds);
      cursors = await Promise.all(
        freshRecords.map(async freshRecord => ({ record: freshRecord, lastAuditEntryId: '', hash: await hashRecord(freshRecord) }))
      );
    } else {
      // Step 1: batch audit-before
      const auditsBefore = await collection.getAudit(allIds);
      const auditBeforeMap = new Map(auditsBefore.map(a => [a.id, a]));

      // Step 2: batch live-records + audit-after in parallel
      const [freshRecords, auditsAfter] = await Promise.all([
        collection.get(allIds),
        collection.getAudit(allIds),
      ]);
      const freshRecordMap = new Map(freshRecords.map(r => [r.id, r]));
      const auditAfterMap = new Map(auditsAfter.map(a => [a.id, a]));

      // Step 3: check consistency per record; collect those that need a per-record retry
      type ConsistentResult = { id: string; freshRecord: MXDBRecord; lastAuditEntryId: string };
      const consistent: ConsistentResult[] = [];
      const needsRetry: string[] = [];

      for (const record of records) {
        const id = record.id;
        const auditBefore = auditBeforeMap.get(id);
        const auditAfter = auditAfterMap.get(id);

        if ((auditBefore != null && auditor.isDeleted(auditBefore)) || (auditAfter != null && auditor.isDeleted(auditAfter))) {
          continue;
        }

        const idBefore = auditBefore != null ? (auditor.getLastEntryId(auditBefore) ?? '') : '';
        const idAfter = auditAfter != null ? (auditor.getLastEntryId(auditAfter) ?? '') : '';

        if (idBefore === idAfter) {
          const freshRecord = freshRecordMap.get(id);
          if (freshRecord == null) {
            continue;
          }
          consistent.push({ id, freshRecord, lastAuditEntryId: idAfter });
        } else {
          needsRetry.push(id);
        }
      }

      // Step 4: hash consistent records in parallel
      const consistentCursors = await Promise.all(consistent.map(async ({ freshRecord, lastAuditEntryId }) => ({
        record: freshRecord,
        lastAuditEntryId,
        hash: await hashRecord(freshRecord),
      } as MXDBActiveRecordCursor & { hash: string })));

      // Step 5: per-record retry for the rare inconsistent cases
      const retryCursors = await Promise.all(needsRetry.map(async (id): Promise<(MXDBActiveRecordCursor & { hash: string }) | null> => {
        try {
          let lastAuditEntryId = '';
          let freshRecord: MXDBRecord | undefined;
          let tombstoned = false;
          let lastIdBefore = '';
          let lastIdAfter = '';
          let attemptsUsed = 0;
          for (let attempt = 0; attempt < 4; attempt++) {
            attemptsUsed = attempt + 1;
            const auditBefore = await collection.getAudit(id);
            if (auditBefore != null && auditor.isDeleted(auditBefore)) {
              tombstoned = true;
              break;
            }
            const idBefore = auditBefore != null ? (auditor.getLastEntryId(auditBefore) ?? '') : '';
            const candidate = (await collection.get([id]))[0];
            const auditAfter = await collection.getAudit(id);
            if (auditAfter != null && auditor.isDeleted(auditAfter)) {
              tombstoned = true;
              break;
            }
            const idAfter = auditAfter != null ? (auditor.getLastEntryId(auditAfter) ?? '') : '';
            lastIdBefore = idBefore;
            lastIdAfter = idAfter;
            if (idBefore === idAfter) { freshRecord = candidate; lastAuditEntryId = idAfter; break; }
          }
          if (tombstoned || freshRecord == null) return null;
          if (freshRecord === undefined && lastAuditEntryId === '') {
            this.#logger.warn('[s2c] gave up on pair consistency after retries — skipping', {
              collectionName, recordId: id, attempts: attemptsUsed, idBefore: lastIdBefore, idAfter: lastIdAfter,
            });
            return null;
          }
          return { record: freshRecord, lastAuditEntryId, hash: await hashRecord(freshRecord) };
        } catch (error) {
          if (isTransientMongoCloseError(error)) {
            this.#logger.warn('[s2c] #buildAndPush: aborted by client close (shutdown race)', { collectionName, recordId: id });
          } else {
            this.#logger.error('[s2c] #buildAndPush: failed to build active cursor (retry)', { collectionName, recordId: id, error: error as Record<string, unknown> });
          }
          return null;
        }
      }));

      cursors = [...consistentCursors, ...retryCursors.filter((c): c is MXDBActiveRecordCursor & { hash: string } => c != null)];
    }

    // Keep-worthy diagnostic: what this authoritative/change-stream push actually delivers. A
    // `recordsIn > cursorsBuilt` gap means records were dropped while building cursors (tombstoned
    // or pair-inconsistent); `cursorsBuilt: 0` means nothing is pushed at all for these records.
    this.#logger.debug('[s2c] buildAndPush built cursors', {
      collectionName, addToFilter, disableAudit, recordsIn: records.length, cursorsBuilt: cursors.length,
    });
    if (cursors.length === 0) return;
    this.#sd.push([{ collectionName, records: cursors }], addToFilter);
  }

  async #buildDeleteCursors(collectionName: string, recordIds: string[]): Promise<MXDBDeletedRecordCursor[]> {
    if (recordIds.length === 0) return [];
    const db = this.#getDb?.();
    if (db == null) return [];

    let collection: ReturnType<typeof db.use>;
    try { collection = db.use(collectionName); }
    catch { return []; }

    const disableAudit = this.#disableAuditByCollection.get(collectionName) === true;
    const cursors: MXDBDeletedRecordCursor[] = [];

    for (const recordId of recordIds) {
      try {
        let lastAuditEntryId = '';
        if (!disableAudit) {
          const serverAudit = await collection.getAudit(recordId);
          if (serverAudit != null) {
            lastAuditEntryId = auditor.getLastEntryId(serverAudit) ?? '';
          }
        }
        cursors.push({ recordId, lastAuditEntryId });
      } catch (error) {
        if (isTransientMongoCloseError(error)) {
          this.#logger.warn('[s2c] #buildDeleteCursors: aborted by client close (shutdown race)', {
            collectionName, recordId,
          });
        } else {
          this.#logger.error('[s2c] #buildDeleteCursors: failed to build delete cursor', {
            collectionName,
            recordId,
            error: error as Record<string, unknown>,
          });
        }
      }
    }

    return cursors;
  }
}
