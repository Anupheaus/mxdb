import type { PromiseMaybe, Record } from '@anupheaus/common';
import type { MXDBCollection, QueryProps } from '../../common';
import type { UseCollection } from './useCollection';

export type UseCollectionFn = <RecordType extends Record>(collection: MXDBCollection<RecordType>) => UseCollection<RecordType>;

export interface SeedWithPropsWithFixedRecords<RecordType extends Record> {
  count?: number;
  fixedRecords: RecordType[];
  create?(): RecordType;
  validate?(record: RecordType): RecordType | boolean | void;
}

export interface SeedWithPropsWithCreate<RecordType extends Record> {
  count: number;
  fixedRecords?: RecordType[];
  create(): RecordType;
  validate?(record: RecordType): RecordType | boolean | void;
}

export type SeedWithProps<RecordType extends Record> = SeedWithPropsWithFixedRecords<RecordType> | SeedWithPropsWithCreate<RecordType>;

/** The seedWith helper for this collection. Use the server's useCollection() for cross-collection access. */
export type SeedWithFn<RecordType extends Record = Record> = (props: SeedWithProps<RecordType>) => Promise<RecordType[] | undefined>;

export interface OnDeletePayload {
  recordIds: string[];
}

export interface OnUpsertPayload<RecordType extends Record = Record> {
  records: RecordType[];
  insertedIds: string[];
  updatedIds: string[];
}

/** One record an `onBeforeUpsert` hook amended, and why, in words for the user. */
export interface OnBeforeUpsertAmendmentNote {
  /** The amended record's id. */
  id: string;
  /** What was put back and why (e.g. "Only an admin can change the business name, so it was put back."). */
  note: string;
}

/**
 * What an `onBeforeUpsert` hook may return: a note for each record it amended in a way the user should hear about.
 * Returning nothing (or notes for records it did not change) reports nothing.
 */
export type OnBeforeUpsertResult = OnBeforeUpsertAmendmentNote[] | void;

export interface OnClearPayload {
  collectionName: string;
}

/**
 * Why the read gate is being asked: `'read'` to decide what the caller may be sent, `'write'` to decide whether a
 * client's change to a stored record may be saved. A gate that only limits what is delivered (a device's date
 * window, say) applies that limit to reads alone; ownership and role rules apply to both.
 */
export type OnQueryPurpose = 'read' | 'write';

export interface OnQueryPayload {
  request: QueryProps<any>;
  userId: string | undefined;
  /** Absent means `'read'` (gates written before this field existed treat every call as a read). */
  purpose?: OnQueryPurpose;
}

export interface CollectionExtensionHooks<RecordType extends Record = Record> {
  /**
   * Runs on the server instance performing the delete — a server-side `remove` or a client delete
   * arriving via sync — before anything is deleted, so the records can still be read. Only receives
   * ids that are currently stored. Throw to reject the delete.
   */
  onBeforeDelete?(payload: OnDeletePayload): Promise<void> | void;
  /**
   * Runs when a delete is observed from the MongoDB change stream, so it runs on every instance
   * watching the stream (including when another instance or process performed the delete).
   * Use for cross-collection updates or other reactions to the deletion.
   */
  onAfterDelete?(payload: OnDeletePayload): Promise<void> | void;
  /**
   * Runs on the server instance performing the upsert — a server-side `upsert` or a client write
   * arriving via sync — before anything is persisted, once per write and only for records that are new
   * or changed. The records may be amended in place; the amended records are what gets written (and
   * synced back to the client). Throw to reject the write.
   *
   * An amendment is silent unless the hook returns a note for the record (`{ id, note }[]`): for a synced
   * client write the note reaches the client's `onSyncAmended` so the user is told what was put back and
   * why. Notes are ignored on a server-side write and for a record the hook left unchanged.
   */
  onBeforeUpsert?(payload: OnUpsertPayload<RecordType>): Promise<OnBeforeUpsertResult> | OnBeforeUpsertResult;
  /**
   * Runs when an insert/update is observed from the MongoDB change stream, so it runs on every
   * instance watching the stream (including when another instance or process performed the write).
   * Use for cross-collection updates or other reactions to the change.
   */
  onAfterUpsert?(payload: OnUpsertPayload<RecordType>): Promise<void> | void;
  /**
   * Runs only when this server instance performs the clear, before anything is removed. Throw to reject it.
   */
  onBeforeClear?(payload: OnClearPayload): Promise<void> | void;
  /**
   * Runs only when this server instance performs the clear, after the records are removed (not driven by
   * the change stream).
   */
  onAfterClear?(payload: OnClearPayload): Promise<void> | void;
  /** Run when seeding. Receives seedWith for this collection only; use the server's useCollection() for other collections. */
  onSeed?(seedWith: SeedWithFn<RecordType>): Promise<void>;
  /**
   * The collection's read gate. Runs before every client read — `query`, `get`, `getAll` and `distinct`,
   * as actions and as subscriptions. Receives the request and the authenticated userId (`undefined` when
   * the caller is not signed in). Return a modified request to apply server-side filters (e.g. security
   * scoping) or to interpret {@link QueryProps.serverHints}; return void/undefined to use the request
   * unchanged. For `get` and `getAll` the request is empty and only the returned filters are used, AND-ed
   * with the requested ids for `get` — so AND your scope onto `request.filters` rather than replacing it.
   *
   * It is also asked, with `purpose: 'write'`, whether a client may change a stored record: a change to a record
   * outside the returned filters is refused. A scope that only limits delivery, not authority, should be left out
   * of a `'write'` answer, so an edit made offline to a record that has since left that scope is still saved
   * (and then evicted from the client, because it is no longer readable).
   */
  onQuery?(payload: OnQueryPayload): PromiseMaybe<QueryProps<any> | void>;
}

const extensionRegistry = new WeakMap<MXDBCollection, CollectionExtensionHooks>();

export function extendCollection<RecordType extends Record>(
  collection: MXDBCollection<RecordType>,
  hooks: CollectionExtensionHooks<RecordType>,
): void {
  const existing = extensionRegistry.get(collection);
  extensionRegistry.set(collection, { ...existing, ...hooks } as CollectionExtensionHooks<RecordType>);
}

export function getCollectionExtensions<RecordType extends Record>(
  collection: MXDBCollection<RecordType>,
): CollectionExtensionHooks<RecordType> | undefined {
  return extensionRegistry.get(collection) as CollectionExtensionHooks<RecordType> | undefined;
}
