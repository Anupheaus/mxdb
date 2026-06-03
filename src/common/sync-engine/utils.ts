import type { Record as MXDBRecord } from '@anupheaus/common';
import type {
  MXDBActiveRecordState,
  MXDBDeletedRecordState,
  MXDBActiveRecordCursor,
  MXDBDeletedRecordCursor,
  MXDBRecordCursors,
  MXDBSyncEngineResponse,
} from './models';

// ─── Type guards ──────────────────────────────────────────────────────────────

export function isActiveRecordState<T extends MXDBRecord = MXDBRecord>(
  state: MXDBActiveRecordState<T> | MXDBDeletedRecordState,
): state is MXDBActiveRecordState<T> {
  return 'record' in state;
}

export function isDeletedRecordState<T extends MXDBRecord = MXDBRecord>(
  state: MXDBActiveRecordState<T> | MXDBDeletedRecordState,
): state is MXDBDeletedRecordState {
  return !('record' in state);
}

export function isActiveCursor<T extends MXDBRecord = MXDBRecord>(
  cursor: MXDBActiveRecordCursor<T> | MXDBDeletedRecordCursor,
): cursor is MXDBActiveRecordCursor<T> {
  return 'record' in cursor;
}

export function isDeletedCursor<T extends MXDBRecord = MXDBRecord>(
  cursor: MXDBActiveRecordCursor<T> | MXDBDeletedRecordCursor,
): cursor is MXDBDeletedRecordCursor {
  return !('record' in cursor);
}

// ─── ID helpers ───────────────────────────────────────────────────────────────

export function getCursorId<T extends MXDBRecord = MXDBRecord>(
  cursor: MXDBActiveRecordCursor<T> | MXDBDeletedRecordCursor,
): string {
  return isActiveCursor(cursor) ? cursor.record.id : cursor.recordId;
}

export function getStateId<T extends MXDBRecord = MXDBRecord>(
  state: MXDBActiveRecordState<T> | MXDBDeletedRecordState,
): string {
  return isActiveRecordState(state) ? state.record.id : state.recordId;
}

// ─── Response helpers ─────────────────────────────────────────────────────────

export function getSuccessfulIds(response: MXDBSyncEngineResponse, collectionName: string): string[] {
  return response.find(r => r.collectionName === collectionName)?.successfulRecordIds ?? [];
}

export function addIdsToResponse(
  response: MXDBSyncEngineResponse,
  collectionName: string,
  ids: string[],
): MXDBSyncEngineResponse {
  if (ids.length === 0) return response;
  const existing = response.find(r => r.collectionName === collectionName);
  if (existing) {
    const deduped = [...new Set([...existing.successfulRecordIds, ...ids])];
    return response.map(r =>
      r.collectionName === collectionName
        ? { ...r, successfulRecordIds: deduped }
        : r,
    );
  }
  return [...response, { collectionName, successfulRecordIds: [...new Set(ids)] }];
}

export function getDeclinedIds(response: MXDBSyncEngineResponse, collectionName: string): string[] {
  return response.find(r => r.collectionName === collectionName)?.declinedRecordIds ?? [];
}

export function addDeclinedIdsToResponse(
  response: MXDBSyncEngineResponse,
  collectionName: string,
  ids: string[],
): MXDBSyncEngineResponse {
  if (ids.length === 0) return response;
  const existing = response.find(r => r.collectionName === collectionName);
  if (existing) {
    const deduped = [...new Set([...(existing.declinedRecordIds ?? []), ...ids])];
    return response.map(r =>
      r.collectionName === collectionName
        ? { ...r, declinedRecordIds: deduped }
        : r,
    );
  }
  return [...response, { collectionName, successfulRecordIds: [], declinedRecordIds: [...new Set(ids)] }];
}

// ─── Squash ───────────────────────────────────────────────────────────────────

/**
 * Squash multiple cursor push batches into one.
 * Delete always wins; for updates, the one with the latest lastAuditEntryId wins.
 */
export function squashCursors<T extends MXDBRecord = MXDBRecord>(
  queue: MXDBRecordCursors<T>[],
): MXDBRecordCursors<T> {
  // Map: collectionName -> recordId -> cursor
  const byCollection = new Map<string, Map<string, MXDBActiveRecordCursor<T> | MXDBDeletedRecordCursor>>();

  for (const batch of queue) {
    for (const col of batch) {
      if (!byCollection.has(col.collectionName)) {
        byCollection.set(col.collectionName, new Map());
      }
      const colMap = byCollection.get(col.collectionName)!;
      for (const cursor of col.records) {
        const id = getCursorId(cursor);
        const existing = colMap.get(id);
        if (existing == null) {
          colMap.set(id, cursor);
        } else if (isDeletedCursor(cursor)) {
          // Delete always wins — deletions are final (no resurrection).
          // A client's pending update may carry a newer ULID than the delete entry,
          // but the record still stays deleted. The delete cursor must always beat
          // an active cursor regardless of lastAuditEntryId ordering.
          colMap.set(id, cursor);
        } else if (isActiveCursor(cursor) && !isDeletedCursor(existing)) {
          // Both are updates — pick the one with the latest lastAuditEntryId
          if (cursor.lastAuditEntryId > existing.lastAuditEntryId) {
            colMap.set(id, cursor);
          }
        }
        // If existing is a delete and cursor is an update, delete wins (do nothing)
      }
    }
  }

  const result: MXDBRecordCursors<T> = [];
  for (const [collectionName, colMap] of byCollection) {
    result.push({ collectionName, records: [...colMap.values()] });
  }
  return result;
}
