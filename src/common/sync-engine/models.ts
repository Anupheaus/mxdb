import type { Record as MXDBRecord } from '@anupheaus/common';
import type { AuditEntry } from '../auditor';

export interface MXDBRecordStatesByCollectionRequest { collectionName: string; recordIds: string[]; }
export type MXDBRecordStatesRequest = MXDBRecordStatesByCollectionRequest[];

// Use 'record' presence to distinguish active vs deleted
export interface MXDBActiveRecordState<T extends MXDBRecord = MXDBRecord> { record: T; audit: AuditEntry[]; }
export interface MXDBDeletedRecordState { recordId: string; audit: AuditEntry[]; }
export interface MXDBRecordStatesByCollection<T extends MXDBRecord = MXDBRecord> { collectionName: string; records: (MXDBActiveRecordState<T> | MXDBDeletedRecordState)[]; }
export type MXDBRecordStates<T extends MXDBRecord = MXDBRecord> = MXDBRecordStatesByCollection<T>[];

// Cursors (lightweight, no full audit)
export interface MXDBActiveRecordCursor<T extends MXDBRecord = MXDBRecord> { record: T; lastAuditEntryId: string; }
export interface MXDBDeletedRecordCursor { recordId: string; lastAuditEntryId: string; }
export interface MXDBRecordCursorsByCollection<T extends MXDBRecord = MXDBRecord> { collectionName: string; records: (MXDBActiveRecordCursor<T> | MXDBDeletedRecordCursor)[]; }
export type MXDBRecordCursors<T extends MXDBRecord = MXDBRecord> = MXDBRecordCursorsByCollection<T>[];

export interface MXDBSyncEngineResponseItem {
  collectionName: string;
  /** Records the client applied (or that are already consistent), e.g. deletes against an unknown/tombstoned id. */
  successfulRecordIds: string[];
  /**
   * Records the client DELIBERATELY did not apply and never will from this push — it has pending
   * local changes it will merge via C2S, the cursor is stale, or the record is locally tombstoned
   * (delete-is-final). The ServerDispatcher must stop re-sending these (they are not lost in
   * transit) without treating them as the "stuck client" anomaly. Absent ⇒ no declines.
   */
  declinedRecordIds?: string[];
}
export type MXDBSyncEngineResponse = MXDBSyncEngineResponseItem[];

export interface MXDBUpdateItemRequest<T extends MXDBRecord = MXDBRecord> {
  collectionName: string;
  deletedRecordIds?: string[];
  records?: { record: T; lastAuditEntryId: string; }[];
}
export type MXDBUpdateRequest<T extends MXDBRecord = MXDBRecord> = MXDBUpdateItemRequest<T>[];

// CD types
export interface ClientDispatcherEnqueueItem { collectionName: string; recordId: string; }
export interface ClientDispatcherRequestRecord { id: string; hash?: string; entries: AuditEntry[]; }
export interface ClientDispatcherRequestItem { collectionName: string; records: ClientDispatcherRequestRecord[]; }
export type ClientDispatcherRequest = ClientDispatcherRequestItem[];

// SD filter
export interface ServerDispatcherFilterRecord { id: string; hash?: string; lastAuditEntryId: string; }
export interface ServerDispatcherFilter { collectionName: string; records: ServerDispatcherFilterRecord[]; deletedRecordIds?: string[]; }

// Error
export class SyncPausedError extends Error {
  constructor() { super('ClientReceiver is paused'); this.name = 'SyncPausedError'; }
}
