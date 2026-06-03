import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import { auditor } from '../auditor';
import {
  type MXDBRecordStatesRequest,
  type MXDBRecordStates,
  type MXDBUpdateRequest,
  type MXDBSyncEngineResponse,
  type MXDBRecordCursors,
  SyncPausedError,
} from './models';
import {
  isActiveCursor,
  isActiveRecordState,
  getCursorId,
  addIdsToResponse,
  addDeclinedIdsToResponse,
} from './utils';

interface ClientReceiverProps {
  onRetrieve<T extends MXDBRecord>(request: MXDBRecordStatesRequest): MXDBRecordStates<T>;
  onUpdate(updates: MXDBUpdateRequest): MXDBSyncEngineResponse;
}

export class ClientReceiver {
  readonly #logger: Logger;
  readonly #props: ClientReceiverProps;
  #isPaused = false;

  constructor(logger: Logger, props: ClientReceiverProps) {
    this.#logger = logger;
    this.#props = props;
    this.#logger.debug('[CR] ClientReceiver created');
  }

  pause(): void {
    this.#isPaused = true;
    this.#logger.debug('[CR] paused');
  }

  resume(): void {
    this.#isPaused = false;
    this.#logger.debug('[CR] resumed');
  }

  process<T extends MXDBRecord>(payload: MXDBRecordCursors<T>): MXDBSyncEngineResponse {
    if (this.#isPaused) {
      this.#logger.debug('[CR] process called while paused — throwing SyncPausedError');
      throw new SyncPausedError();
    }

    // Step 1: Build retrieve request from payload
    const request: MXDBRecordStatesRequest = payload.map(col => ({
      collectionName: col.collectionName,
      recordIds: col.records.map(c => getCursorId(c)),
    }));

    // Step 2: Retrieve local states
    const localStates = this.#props.onRetrieve<T>(request);

    // Build a fast lookup: collectionName -> recordId -> state
    const localMap = new Map<string, Map<string, (typeof localStates[0]['records'][0])>>();
    for (const col of localStates) {
      const colMap = new Map<string, typeof col.records[0]>();
      for (const state of col.records) {
        const id = isActiveRecordState(state) ? state.record.id : state.recordId;
        colMap.set(id, state);
      }
      localMap.set(col.collectionName, colMap);
    }

    // Collect updates and no-local-state delete IDs
    const updatesByCollection = new Map<string, {
      records: { record: T; lastAuditEntryId: string }[];
      deletedRecordIds: string[];
    }>();
    const noLocalStateDeleteIds = new Map<string, string[]>();
    // Records this client DELIBERATELY declines to apply from this push (pending C2S merge, stale
    // anchor, or local tombstone). Reported back so the SD stops re-sending them without treating
    // the non-ack as a stuck-client anomaly. These are NOT lost in transit — the client chose.
    const declinedByCollection = new Map<string, string[]>();
    const declineRecord = (collectionName: string, recordId: string): void => {
      const ids = declinedByCollection.get(collectionName);
      if (ids == null) declinedByCollection.set(collectionName, [recordId]);
      else ids.push(recordId);
    };

    for (const col of payload) {
      const colName = col.collectionName;
      const colLocalMap = localMap.get(colName) ?? new Map();

      for (const cursor of col.records) {
        const id = getCursorId(cursor);
        const localState = colLocalMap.get(id);

        if (localState == null) {
          // No local state
          if (isActiveCursor(cursor)) {
            if (!updatesByCollection.has(colName)) {
              updatesByCollection.set(colName, { records: [], deletedRecordIds: [] });
            }
            updatesByCollection.get(colName)!.records.push({
              record: cursor.record as T,
              lastAuditEntryId: cursor.lastAuditEntryId,
            });
          } else {
            if (!noLocalStateDeleteIds.has(colName)) {
              noLocalStateDeleteIds.set(colName, []);
            }
            noLocalStateDeleteIds.get(colName)!.push(id);
          }
          continue;
        }

        // Has local state — if it's a tombstone, refuse to resurrect. Delete-is-final:
        // once a record is deleted locally, no incoming active cursor may bring it back.
        // A concurrent delete cursor for the same record is a no-op and still succeeds.
        if (!isActiveRecordState(localState)) {
          if (isActiveCursor(cursor)) {
            // Deliberate decline: delete-is-final, refuse resurrection. Tell the SD to stop sending.
            declineRecord(colName, id);
            continue;
          }
          if (!noLocalStateDeleteIds.has(colName)) {
            noLocalStateDeleteIds.set(colName, []);
          }
          noLocalStateDeleteIds.get(colName)!.push(id);
          continue;
        }

        // Has local active state — check branch-only
        const localAudit = { id, entries: localState.audit };
        const branchOnly = auditor.isBranchOnly(localAudit);

        if (!branchOnly) {
          // Has pending local changes.
          // Delete-is-final: a delete cursor always wins, even over pending C2S changes —
          // once the server tombstones a record, the client's pending updates are moot
          // (the SR would reject them anyway). Write a local tombstone so subsequent
          // active cursors cannot resurrect the record.
          if (!isActiveCursor(cursor)) {
            if (!updatesByCollection.has(colName)) {
              updatesByCollection.set(colName, { records: [], deletedRecordIds: [] });
            }
            updatesByCollection.get(colName)!.deletedRecordIds.push(id);
            continue;
          }
          // Deliberate decline: active cursor skipped while local pending changes exist; the CD
          // will reconcile via C2S. Tell the SD to stop re-sending this version.
          declineRecord(colName, id);
          continue;
        }

        // Staleness guard: skip active cursors whose anchor is older than the client's.
        // Delete cursors bypass this check — delete-is-final. A client's update may carry
        // a newer ULID than the server's Deleted entry, but the record must still be deleted.
        //
        // An EMPTY anchor means the collection is not server-audited (`disableAudit`): there
        // is no audit ULID to order versions by, so the staleness comparison is meaningless
        // and the server's write is authoritative. Without this bypass the client anchors the
        // first synced record to a random ULID (`lastAuditEntryId || ulid()` in DbCollection),
        // and every subsequent update — which also carries an empty anchor — would be skipped
        // as "stale", leaving the client stuck on the first version (e.g. a job permanently
        // showing "working"). Empty-anchor active cursors therefore always apply.
        if (isActiveCursor(cursor) && cursor.lastAuditEntryId !== '') {
          const branchUlid = auditor.getBranchUlid(localAudit);
          const localBranchId = branchUlid ?? '';

          if (cursor.lastAuditEntryId < localBranchId) {
            // Deliberate decline: the local version is newer. Tell the SD to stop re-sending.
            declineRecord(colName, id);
            continue;
          }
        }

        if (!updatesByCollection.has(colName)) {
          updatesByCollection.set(colName, { records: [], deletedRecordIds: [] });
        }
        if (isActiveCursor(cursor)) {
          updatesByCollection.get(colName)!.records.push({
            record: cursor.record as T,
            lastAuditEntryId: cursor.lastAuditEntryId,
          });
        } else {
          updatesByCollection.get(colName)!.deletedRecordIds.push(id);
        }
      }
    }

    // Step 3: Build MXDBUpdateRequest and call onUpdate
    const updateRequest: MXDBUpdateRequest = [];
    for (const [colName, updates] of updatesByCollection) {
      const item: MXDBUpdateRequest[0] = { collectionName: colName };
      if (updates.records.length > 0) item.records = updates.records as { record: MXDBRecord; lastAuditEntryId: string }[];
      if (updates.deletedRecordIds.length > 0) item.deletedRecordIds = updates.deletedRecordIds;
      updateRequest.push(item);
    }

    let response: MXDBSyncEngineResponse = [];
    if (updateRequest.length > 0) {
      response = this.#props.onUpdate(updateRequest);
    }

    // Step 4: Merge noLocalStateDeleteIds into response
    for (const [colName, ids] of noLocalStateDeleteIds) {
      response = addIdsToResponse(response, colName, ids);
    }

    // Step 5: Report deliberately-declined records so the SD stops re-sending them.
    for (const [colName, ids] of declinedByCollection) {
      response = addDeclinedIdsToResponse(response, colName, ids);
    }

    return response;
  }
}
