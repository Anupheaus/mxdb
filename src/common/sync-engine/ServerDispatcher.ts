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
  /** Identifies the connected client (socket id) for diagnostics. Optional; defaults to `'unknown'`. */
  clientId?: string;
}

/**
 * How many times in a row a client may RESOLVE an S2C dispatch without acknowledging a given
 * record before the SD stops re-queuing it. Counted PER RECORD ID: a resolved response (even an
 * empty `[]`) that omits the record is a deliberate refusal and increments that id's streak; the
 * id being acknowledged resets it to zero. A REJECTED dispatch (`SyncPausedError` / transport
 * failure) is not an answer at all and never counts. On reaching this many consecutive ignores
 * the SD drops the record from its queue and logs an error (see {@link ServerDispatcher.#dispatch}
 * step 6).
 */
const MAX_CONSECUTIVE_IGNORES = 3;

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
  // Map<collectionName, Map<recordId, consecutiveIgnoreCount>> — how many times in a row a
  // resolved dispatch has omitted (refused) each record. Reset to 0 (entry deleted) the moment
  // the client acknowledges the record; cleared when the record is dropped after the cap.
  #ignoredCounts: Map<string, Map<string, number>> = new Map();

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

      // Build Maps from response for O(1) lookups in steps 5 and 6.
      const responseByCol = new Map(response.map(r => [r.collectionName, r.successfulRecordIds]));
      const declinedByCol = new Map(response.map(r => [r.collectionName, r.declinedRecordIds ?? []]));

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

      // Step 6: Trim #queue and push back failed records.
      //
      // This block runs ONLY because `onDispatch` resolved (`success === true`) — i.e. the client
      // answered the request. A record the client neither acknowledged (`successfulRecordIds`) nor
      // explicitly declined (`declinedRecordIds`) was therefore lost or silently dropped: it counts
      // toward the per-record ignore cap. A DECLINED record was deliberately not applied (pending
      // C2S merge / stale / tombstone) and converges by another path — we stop re-sending it but
      // never count it. A REJECTED dispatch (SyncPausedError / transport failure) never reaches
      // here: it is caught below and retried wholesale without counting.
      this.#queue.splice(0, queueLength);

      // Re-queue failed cursors preserving their original addToFilter flag, but give up on any
      // record the client has now ignored MAX_CONSECUTIVE_IGNORES times in a row.
      for (const col of freshRequest) {
        const colName = col.collectionName;
        const successIds = responseByCol.get(colName) ?? [];
        const successSet = new Set(successIds);
        const declinedSet = new Set(declinedByCol.get(colName) ?? []);
        const colFlags = flagsByCol.get(colName) ?? new Map<string, boolean>();

        // Any record the client acknowledged this round clears its ignore streak.
        for (const ackedId of successSet) this.#clearIgnoredCount(colName, ackedId);

        const failed = col.records.filter(c => !successSet.has(getCursorId(c)));
        if (failed.length === 0) continue;

        const toRequeue: (MXDBActiveRecordCursor | MXDBDeletedRecordCursor)[] = [];
        for (const cursor of failed) {
          const id = getCursorId(cursor);

          // The client explicitly declined this record (pending C2S merge / stale / tombstone). It
          // is deliberately not applying our version and will converge by another path — stop
          // re-sending it, and do NOT treat the non-ack as the stuck-client anomaly.
          if (declinedSet.has(id)) {
            this.#clearIgnoredCount(colName, id);
            continue;
          }

          const ignoredCount = this.#bumpIgnoredCount(colName, id);
          if (ignoredCount < MAX_CONSECUTIVE_IGNORES) {
            toRequeue.push(cursor);
            continue;
          }

          // The client answered the request but neither applied nor declined this record
          // MAX_CONSECUTIVE_IGNORES times running. Stop re-queuing it (drop) and record the error
          // with as much cheap context as we can gather.
          this.#clearIgnoredCount(colName, id);
          const isDelete = isDeletedCursor(cursor);
          this.#logger.error(
            `[SD] Client neither applied nor declined an S2C record ${MAX_CONSECUTIVE_IGNORES} times in a row `
            + `(while answering the dispatches it was sent in), so the server has DROPPED the pending update for `
            + `this record to avoid an unbounded re-send loop. Execution has NOT stopped and the server continues to `
            + `run normally — but this should never happen and is important to investigate: the client is likely stuck `
            + `and will not receive this record's current state until it next changes.`,
            {
              clientId: this.#props.clientId ?? 'unknown',
              collectionName: colName,
              recordId: id,
              consecutiveIgnores: MAX_CONSECUTIVE_IGNORES,
              cursorType: isDelete ? 'delete' : 'active',
              lastAuditEntryId: cursor.lastAuditEntryId,
              cursorHash: isDelete ? undefined : (cursor as unknown as { hash?: string }).hash,
              addToFilter: colFlags.get(id) ?? true,
              recordsSentInBatch: col.records.length,
              acknowledgedCountInBatch: successSet.size,
              acknowledgedRecordIdsInBatch: [...successSet],
              declinedRecordIdsInBatch: [...declinedSet],
            },
          );
        }

        if (toRequeue.length === 0) continue;

        // Group the survivors by their addToFilter flag so each re-queued batch carries a
        // consistent flag value.
        const groups = new Map<boolean, (MXDBActiveRecordCursor | MXDBDeletedRecordCursor)[]>();
        for (const cursor of toRequeue) {
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

  /** Increment and return the consecutive-ignore count for a record (creating maps lazily). */
  #bumpIgnoredCount(collectionName: string, recordId: string): number {
    let counts = this.#ignoredCounts.get(collectionName);
    if (counts == null) {
      counts = new Map();
      this.#ignoredCounts.set(collectionName, counts);
    }
    const next = (counts.get(recordId) ?? 0) + 1;
    counts.set(recordId, next);
    return next;
  }

  /** Reset a record's consecutive-ignore count (on acknowledgement or after dropping it). */
  #clearIgnoredCount(collectionName: string, recordId: string): void {
    const counts = this.#ignoredCounts.get(collectionName);
    if (counts == null) return;
    counts.delete(recordId);
    if (counts.size === 0) this.#ignoredCounts.delete(collectionName);
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
