import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import {
  type MXDBRecordCursors,
  type MXDBActiveRecordCursor,
  type MXDBDeletedRecordCursor,
  type MXDBSyncEngineResponse,
  type ServerDispatcherFilter,
  type ServerDispatcherFilterRecord,
  SyncPausedError,
} from './models';
import { isActiveCursor, isDeletedCursor, getCursorId } from './utils';

interface ServerDispatcherProps {
  onDispatch<T extends MXDBRecord>(payload: MXDBRecordCursors<T>): Promise<MXDBSyncEngineResponse>;
  retryInterval?: number;
}

/**
 * One queue entry = one `push(...)` call. The `addToFilter` flag is tracked per batch
 * and then propagated to the squashed per-cursor view at dispatch time.
 *
 *  - `true`: "authoritative" push (getAll / query / get / SR merge result). On success
 *    the record gets added to `#filter` (CR is now known to have it).
 *  - `false`: change-stream-style push. The record must already be in `#filter` for the
 *    cursor to be sent at all — change-stream fan-out is not allowed to bootstrap
 *    records the CR has never acknowledged.
 */
interface QueuedBatch {
  cursors: MXDBRecordCursors;
  addToFilter: boolean;
}

/** Per-cursor view produced by the flag-aware squash step. */
interface TaggedCursor {
  cursor: MXDBActiveRecordCursor | MXDBDeletedRecordCursor;
  addToFilter: boolean;
}

export class ServerDispatcher {
  readonly #logger: Logger;
  readonly #props: ServerDispatcherProps;
  #isPaused = false;
  #inFlight = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  #queue: QueuedBatch[] = [];
  // Map<collectionName, Map<recordId, FilterRecord>> — O(1) per-collection and per-record lookups.
  #filter: Map<string, Map<string, ServerDispatcherFilterRecord>> = new Map();
  #deletedRecordIds: Map<string, Set<string>> = new Map();

  constructor(logger: Logger, props: ServerDispatcherProps) {
    this.#logger = logger;
    this.#props = props;
    this.#logger.debug('[SD] ServerDispatcher created');
  }

  pause(): void {
    if (this.#isPaused) return;
    this.#isPaused = true;
    this.#logger.debug('[SD] paused');
  }

  resume(): void {
    if (!this.#isPaused) return;
    this.#isPaused = false;
    this.#logger.debug('[SD] resumed');
    if (!this.#inFlight && this.#retryTimer == null) {
      void this.#dispatch();
    }
  }

  /**
   * SR-only entry point for seeding the filter without dispatching. Used by the
   * ServerReceiver to register branched-only acknowledgements and "client already
   * up to date" records so that future deletes/updates can pass the filter check.
   *
   * No other caller should use this — getAll/query/get/subscription paths and the
   * MongoDB change stream must go through {@link push}. The filter is otherwise
   * managed internally by {@link #dispatch}'s success path.
   */
  updateFilter(filters: ServerDispatcherFilter[]): void {
    for (const filterItem of filters) {
      const colName = filterItem.collectionName;
      let colMap = this.#filter.get(colName);
      if (colMap == null) {
        colMap = new Map(filterItem.records.map(r => [r.id, { ...r }]));
        this.#filter.set(colName, colMap);
      } else {
        for (const rec of filterItem.records) {
          const existingRec = colMap.get(rec.id);
          if (existingRec == null) {
            colMap.set(rec.id, { ...rec });
          } else {
            existingRec.hash = rec.hash;
            existingRec.lastAuditEntryId = rec.lastAuditEntryId;
          }
        }
      }

      // If the client reports an active record (hash != null), clear any prior
      // tombstone from #deletedRecordIds. This happens when a change-stream
      // delete arrives before the client's CD.start() seeds the filter — the
      // tombstone is recorded but the client hasn't been told yet. Without this
      // clear, the subsequent authoritative delete cursor from the SR disparity
      // path (addToFilter=true) hits the "confirmed-deleted" gate and is dropped,
      // leaving the client with a stale local copy forever.
      for (const rec of filterItem.records) {
        if (rec.hash != null) {
          const deletedSet = this.#deletedRecordIds.get(colName);
          if (deletedSet?.has(rec.id)) {
            deletedSet.delete(rec.id);
          }
        }
      }

      if (filterItem.deletedRecordIds && filterItem.deletedRecordIds.length > 0) {
        if (!this.#deletedRecordIds.has(colName)) {
          this.#deletedRecordIds.set(colName, new Set());
        }
        const deletedSet = this.#deletedRecordIds.get(colName)!;
        for (const id of filterItem.deletedRecordIds) deletedSet.add(id);
      }
    }
  }

  /**
   * Enqueue a cursor batch for dispatch to the CR.
   *
   * @param addToFilter
   *   - `true` (default): authoritative push. On successful dispatch of an active
   *     cursor, the record is added to `#filter` (the CR has now acknowledged it).
   *     Use for getAll/query/get/subscription paths and the SR fan-out.
   *   - `false`: change-stream-style push. On dispatch, cursors whose record is
   *     NOT already in `#filter` are **dropped** — the CR hasn't acked the record
   *     so change-stream fan-out cannot deliver an update for it. Use for the
   *     MongoDB change stream.
   */
  push<T extends MXDBRecord>(request: MXDBRecordCursors<T>, addToFilter: boolean = true): void {
    this.#queue.push({ cursors: request as MXDBRecordCursors, addToFilter });
    if (!this.#isPaused && !this.#inFlight && this.#retryTimer == null) {
      void this.#dispatch();
    }
  }

  /**
   * Squash all queued batches into a single per-collection map of tagged cursors.
   *
   * Merge rules:
   *   - Delete cursors always beat active cursors (delete-is-final).
   *   - Between two active cursors, the one with the later `lastAuditEntryId` wins.
   *   - On equal `lastAuditEntryId`, the LATER-enqueued cursor wins. Change-stream
   *     events from Mongo are delivered in oplog (write) order, and `#buildAndPush`
   *     reads the current audit's last entry id for each event — so under concurrent
   *     writes, multiple events can race and produce cursors with the same
   *     `lastAuditEntryId` but different `record` payloads (each capturing the
   *     fullDocument at its own write point). The last-enqueued cursor reflects
   *     the most recent oplog position and therefore the freshest record state.
   *   - `addToFilter` flags OR together: if any batch for this record wanted to
   *     add it to the filter, the merged cursor carries `addToFilter=true`. This
   *     matches the user intent — an authoritative push must still succeed in
   *     registering the record even if a change-stream batch squashed with it.
   */
  #squashQueue(): Map<string, Map<string, TaggedCursor>> {
    const byCollection = new Map<string, Map<string, TaggedCursor>>();

    for (const batch of this.#queue) {
      for (const col of batch.cursors) {
        if (!byCollection.has(col.collectionName)) {
          byCollection.set(col.collectionName, new Map());
        }
        const colMap = byCollection.get(col.collectionName)!;
        for (const cursor of col.records) {
          const id = getCursorId(cursor);
          const existing = colMap.get(id);
          if (existing == null) {
            colMap.set(id, { cursor, addToFilter: batch.addToFilter });
            continue;
          }
          // OR the flags — authoritative wins over change-stream.
          const mergedFlag = existing.addToFilter || batch.addToFilter;
          if (isDeletedCursor(cursor)) {
            colMap.set(id, { cursor, addToFilter: mergedFlag });
          } else if (isActiveCursor(cursor) && !isDeletedCursor(existing.cursor)) {
            // `>=` so the LATER-enqueued cursor wins on ties. See method doc: concurrent
            // change-stream events can produce cursors with identical `lastAuditEntryId`
            // but different record snapshots; the later arrival is the freshest.
            if (cursor.lastAuditEntryId >= existing.cursor.lastAuditEntryId) {
              colMap.set(id, { cursor, addToFilter: mergedFlag });
            } else {
              existing.addToFilter = mergedFlag;
            }
          } else {
            // existing is a delete, cursor is an update — delete wins, just OR the flag
            existing.addToFilter = mergedFlag;
          }
        }
      }
    }

    return byCollection;
  }

  async #dispatch(): Promise<void> {
    // Step 1: Snapshot queue length and squash
    const queueLength = this.#queue.length;
    const squashed = this.#squashQueue();

    // Step 2: Filter against #filter and #deletedRecordIds
    const freshRequest: MXDBRecordCursors = [];
    // Parallel bookkeeping: per (collectionName, recordId) → addToFilter flag, used in step 5
    const flagsByCol = new Map<string, Map<string, boolean>>();

    for (const [colName, colMap] of squashed) {
      const filterRecordsMap = this.#filter.get(colName);
      const deletedSet = this.#deletedRecordIds.get(colName);
      const freshRecords: (MXDBActiveRecordCursor | MXDBDeletedRecordCursor)[] = [];
      const colFlags = new Map<string, boolean>();

      for (const { cursor, addToFilter } of colMap.values()) {
        const id = getCursorId(cursor);
        const filterRec = filterRecordsMap?.get(id);
        const inDeletedSet = deletedSet?.has(id) === true;

        // Delete-is-final: anything targeting a confirmed-deleted id is skipped.
        if (inDeletedSet) {
          continue;
        }

        if (isDeletedCursor(cursor)) {
          if (filterRec == null) {
            if (!addToFilter) {
              // Change-stream fan-out cannot deliver a delete for a record the CR
              // doesn't know about — drop the cursor itself. BUT we still commit the
              // id to #deletedRecordIds so that any stale queued active cursors (or
              // future authoritative pushes) for the same id are blocked. Once the
              // server has tombstoned a record there is no legitimate way an active
              // cursor for it can be sent to any client on this SD: `#buildAndPush`
              // filters tombstoned records on the server side, so any active cursor
              // still in our queue must have been built BEFORE the delete and is now
              // stale. Without this guard those stale cursors leak through and
              // resurrect the record on the CR. (Observed in stress tests where a
              // client reconnected after a server restart, had several pre-delete
              // active cursors queued for a record, then the delete fanned out via
              // change-stream and was dropped here — the queued active cursors then
              // dispatched and re-created the record on that client.)
              if (!this.#deletedRecordIds.has(colName)) {
                this.#deletedRecordIds.set(colName, new Set());
              }
              this.#deletedRecordIds.get(colName)!.add(id);
              continue;
            }
            // Authoritative delete for unknown record — send anyway (e.g. query result
            // discovered the record was deleted and wants the CR to know).
            freshRecords.push(cursor);
          } else if (filterRec.hash == null) {
            // Pending deletion — pick the latest ULID between the cursor and the filter's
            // existing pending-delete marker.
            if (cursor.lastAuditEntryId >= filterRec.lastAuditEntryId) {
              freshRecords.push(cursor);
            } else {
              freshRecords.push({ recordId: id, lastAuditEntryId: filterRec.lastAuditEntryId });
            }
          } else {
            // Normal filter record with hash: send the deletion.
            freshRecords.push(cursor);
          }
          colFlags.set(id, addToFilter);
        } else {
          // Active cursor
          if (filterRec == null) {
            if (!addToFilter) {
              continue;
            }
            // Authoritative push of a new record — send.
            freshRecords.push(cursor);
          } else if (filterRec.hash == null) {
            freshRecords.push({ recordId: id, lastAuditEntryId: filterRec.lastAuditEntryId });
          } else {
            const cursorHash = (cursor as unknown as { hash?: string }).hash;
            if (filterRec.hash === cursorHash && filterRec.lastAuditEntryId === cursor.lastAuditEntryId) {
              continue;
            }
            if (cursor.lastAuditEntryId < filterRec.lastAuditEntryId) {
              continue;
            }
            freshRecords.push(cursor);
          }
          colFlags.set(id, addToFilter);
        }
      }

      if (freshRecords.length > 0) {
        freshRequest.push({ collectionName: colName, records: freshRecords });
        flagsByCol.set(colName, colFlags);
      }
    }

    // Step 3: If empty, return without dispatching
    if (freshRequest.length === 0) {
      this.#queue.splice(0, queueLength);
      return;
    }

    // Step 4: Set inFlight and call onDispatch
    this.#inFlight = true;
    let success = false;
    let syncPaused = false;
    let response: MXDBSyncEngineResponse | undefined;

    try {
      response = await this.#props.onDispatch(freshRequest);
      success = true;

      // Build a Map from response for O(1) lookups in steps 5 and 6.
      const responseByCol = new Map(response.map(r => [r.collectionName, r.successfulRecordIds]));

      // Step 5: Update #filter and #deletedRecordIds on success
      for (const col of freshRequest) {
        const colName = col.collectionName;
        const successIds = responseByCol.get(colName) ?? [];
        const successSet = new Set(successIds);
        const colFlags = flagsByCol.get(colName) ?? new Map<string, boolean>();
        let filterRecordsMap = this.#filter.get(colName);

        for (const cursor of col.records) {
          const id = getCursorId(cursor);
          const addToFilter = colFlags.get(id) ?? true;

          if (isDeletedCursor(cursor)) {
            if (successSet.has(id)) {
              // Delete-is-final: permanently block future cursors for this id, regardless
              // of whether the record was previously in the filter or how the delete was
              // originated (authoritative or change-stream).
              filterRecordsMap?.delete(id);
              if (!this.#deletedRecordIds.has(colName)) {
                this.#deletedRecordIds.set(colName, new Set());
              }
              this.#deletedRecordIds.get(colName)!.add(id);
            } else {
              // Unsuccessfully deleted: mark as pending deletion (remove hash, keep ULID).
              if (filterRecordsMap == null) {
                filterRecordsMap = new Map();
                this.#filter.set(colName, filterRecordsMap);
              }
              const filterRec = filterRecordsMap.get(id);
              if (filterRec != null) {
                filterRec.hash = undefined;
                filterRec.lastAuditEntryId = cursor.lastAuditEntryId;
              } else {
                filterRecordsMap.set(id, { id, lastAuditEntryId: cursor.lastAuditEntryId });
              }
            }
          } else if (isActiveCursor(cursor)) {
            if (!successSet.has(id)) continue;

            const cursorHash = (cursor as unknown as { hash?: string }).hash;
            const filterRec = filterRecordsMap?.get(id);

            if (filterRec != null) {
              // Always keep the existing filter entry in lockstep with what the CR just acked.
              filterRec.hash = cursorHash;
              filterRec.lastAuditEntryId = cursor.lastAuditEntryId;
            } else if (addToFilter) {
              // Authoritative push — add a new filter entry.
              if (filterRecordsMap == null) {
                filterRecordsMap = new Map();
                this.#filter.set(colName, filterRecordsMap);
              }
              filterRecordsMap.set(id, {
                id,
                hash: cursorHash,
                lastAuditEntryId: cursor.lastAuditEntryId,
              });
            }
            // else: change-stream update for a record we dropped earlier — should not reach here
            // because we skipped it in the filter step, but guard anyway.
          }
        }
      }

      // Step 6: Trim #queue and push back failed records
      this.#queue.splice(0, queueLength);

      // Re-queue failed cursors preserving their original addToFilter flag.
      for (const col of freshRequest) {
        const colName = col.collectionName;
        const successIds = responseByCol.get(colName) ?? [];
        const successSet = new Set(successIds);
        const colFlags = flagsByCol.get(colName) ?? new Map<string, boolean>();
        const failed = col.records.filter(c => !successSet.has(getCursorId(c)));
        if (failed.length === 0) continue;

        // Group failures by their addToFilter flag so each re-queued batch carries a
        // consistent flag value.
        const groups = new Map<boolean, (MXDBActiveRecordCursor | MXDBDeletedRecordCursor)[]>();
        for (const cursor of failed) {
          const flag = colFlags.get(getCursorId(cursor)) ?? true;
          if (!groups.has(flag)) groups.set(flag, []);
          groups.get(flag)!.push(cursor);
        }
        for (const [flag, cursors] of groups) {
          this.#queue.unshift({
            cursors: [{ collectionName: colName, records: cursors }],
            addToFilter: flag,
          });
        }
      }

    } catch (err) {
      if (err instanceof SyncPausedError) {
        syncPaused = true;
        this.#logger.debug('[SD] SyncPausedError received — scheduling retry');
      } else {
        this.#logger.error('[SD] dispatch error', { error: err });
        this.#inFlight = false;
        throw err;
      }
    } finally {
      this.#inFlight = false;
    }

    if (success) {
      if (this.#queue.length > 0 && !this.#isPaused) {
        void this.#dispatch();
      }
    } else if (syncPaused) {
      if (!this.#isPaused) {
        this.#startRetryTimer();
      }
    }
  }

  #startRetryTimer(): void {
    const interval = this.#props.retryInterval ?? 250;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (!this.#isPaused && !this.#inFlight) {
        void this.#dispatch();
      }
    }, interval);
  }
}
