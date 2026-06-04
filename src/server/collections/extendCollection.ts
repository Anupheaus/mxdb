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

export interface OnClearPayload {
  collectionName: string;
}

export interface OnQueryPayload {
  request: QueryProps<any>;
  userId: string | undefined;
}

export interface CollectionExtensionHooks<RecordType extends Record = Record> {
  /**
   * Runs only when this server instance performs the delete (in the action), before the write.
   * Use for validation or side effects that must run on the instance that handles the request.
   */
  onBeforeDelete?(payload: OnDeletePayload): Promise<void> | void;
  /**
   * Runs when a delete is observed from the MongoDB change stream, so it runs on every instance
   * watching the stream (including when another instance or process performed the delete).
   * Use for cross-collection updates or other reactions to the deletion.
   */
  onAfterDelete?(payload: OnDeletePayload): Promise<void> | void;
  /**
   * Runs only when this server instance performs the upsert (in the action), before the write.
   * Use for validation or side effects that must run on the instance that handles the request.
   */
  onBeforeUpsert?(payload: OnUpsertPayload<RecordType>): Promise<void> | void;
  /**
   * Runs when an insert/update is observed from the MongoDB change stream, so it runs on every
   * instance watching the stream (including when another instance or process performed the write).
   * Use for cross-collection updates or other reactions to the change.
   */
  onAfterUpsert?(payload: OnUpsertPayload<RecordType>): Promise<void> | void;
  /**
   * Runs only when this server instance performs the clear. Use for validation or pre-clear side effects.
   */
  onBeforeClear?(payload: OnClearPayload): Promise<void> | void;
  /**
   * Runs only when this server instance performs the clear (not currently driven by the change stream).
   */
  onAfterClear?(payload: OnClearPayload): Promise<void> | void;
  /** Run when seeding. Receives seedWith for this collection only; use the server's useCollection() for other collections. */
  onSeed?(seedWith: SeedWithFn<RecordType>): Promise<void>;
  /**
   * Run before a query is executed. Receives the request and the authenticated userId.
   * Return a modified request to apply additional server-side filters (e.g. security scoping)
   * or to interpret {@link QueryProps.serverHints}.
   * Return void/undefined to use the original request unchanged.
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
