import type { DataFilters, DataRequest, DataSorts, Record, Unsubscribe } from '@anupheaus/common';
import type { DateTime } from 'luxon';
import type { UseSeedCollection } from '../../server/seeding';

export type MongoDocOf<RecordType extends Record> = {
  [K in keyof RecordType as K extends 'id' ? '_id' : K]: RecordType[K] extends DateTime<any> ? string : RecordType[K];
};

export type ServerQueryHints = { [key: string]: unknown };

export interface QueryProps<
  RecordType extends Record,
  Hints extends ServerQueryHints = ServerQueryHints,
> extends DataRequest<RecordType> {
  getAccurateTotal?: boolean;
  disable?: boolean;
  /** Server-only metadata for collection `onQuery` hooks; not applied to client SQLite queries. */
  serverHints?: Hints;
}

export interface QueryResults<RecordType extends Record> {
  records: RecordType[];
  total: number;
}

export type QueryRequest<
  RecordType extends Record = Record,
  Hints extends ServerQueryHints = ServerQueryHints,
> = Omit<QueryProps<RecordType, Hints>, 'disable'> & {
  collectionName: string;
};

export type QueryResponse = number;

export interface MXDBCollection<RecordType extends Record = any> {
  name: string;
  type: RecordType;
}

export type UseCollection = UseSeedCollection;

// Recursive dot-notation key path type
type NestedKeyOf<T> =
  T extends object
    ? { [K in keyof T & string]: K | `${K}.${NestedKeyOf<T[K]>}` }[keyof T & string]
    : never;

export interface MXDBCollectionIndex<RecordType extends Record = Record> {
  name: string;
  fields: NestedKeyOf<RecordType>[];
  isUnique?: boolean;
  isSparse?: boolean;
}

/** How the collection is synchronised between client and server */
export type MXDBSyncMode = 'Synchronised' | 'ServerOnly' | 'ClientOnly';

export interface MXDBCollectionConfig<RecordType extends Record = any> {
  name: string;
  indexes: MXDBCollectionIndex<RecordType>[];
  /**
   * Default: 'Synchronised'.
   * - 'Synchronised': exists on both client and server, kept in sync.
   * - 'ServerOnly': no client-side storage; never synced to clients.
   * - 'ClientOnly': no server-side storage; never synced to server.
   */
  syncMode?: MXDBSyncMode;
  /**
   * When true, no audit trail is maintained. Sync uses last-write-wins by timestamp.
   * Default: false.
   */
  disableAudit?: boolean;
}

// ─── Error types ────────────────────────────────────────────────────────────

export type MXDBErrorSeverity = 'warning' | 'error' | 'fatal';

export type MXDBErrorCode =
  | 'SYNC_FAILED'
  | 'AUTH_MISSING'
  | 'AUTH_REJECTED'
  | 'ENCRYPTION_FAILED'
  | 'COLLECTION_NOT_FOUND'
  | 'DB_NOT_OPEN'
  | 'TIMEOUT'
  | 'TOKEN_ROTATION_FAILED'
  | 'WRONG_SIDE_COLLECTION'
  | 'INVITE_EXPIRED'
  | 'INVITE_ALREADY_USED'
  | 'INVITE_DISABLED'
  | 'RATE_LIMITED'
  | 'DEVICE_DISABLED'
  | 'REPLAY_FAILED'
  | 'IO_PERMANENT'
  | 'SUBSCRIPTION_FAILED'
  | 'UNKNOWN';

export interface MXDBError {
  code: MXDBErrorCode;
  message: string;
  severity: MXDBErrorSeverity;
  collection?: string;
  recordId?: string;
  originalError?: unknown;
}

// ─── Unified collection change event ────────────────────────────────────────

export type MXDBCollectionChangeEvent<RecordType extends Record = Record> =
  | { type: 'upsert'; records: RecordType[] }
  | { type: 'remove'; recordIds: string[] };

// ─── Unified collection operations interface ────────────────────────────────

/** Shared imperative API available on both client (`useCollection`) and server (`useDb`). */
export interface MXDBCollectionOperations<RecordType extends Record> {
  get(id: string): Promise<RecordType | undefined>;
  get(ids: string[]): Promise<RecordType[]>;
  getAll(): Promise<RecordType[]>;
  upsert(record: RecordType): Promise<void>;
  upsert(records: RecordType[]): Promise<void>;
  remove(id: string): Promise<void>;
  remove(ids: string[]): Promise<void>;
  remove(record: RecordType): Promise<void>;
  remove(records: RecordType[]): Promise<void>;
  query(props?: QueryProps<RecordType>): Promise<QueryResults<RecordType>>;
  find(filters: DataFilters<RecordType>): Promise<RecordType | undefined>;
  distinct<K extends keyof RecordType>(field: K, props?: { filters?: DataFilters<RecordType> }): Promise<RecordType[K][]>;
  onChange(callback: (event: MXDBCollectionChangeEvent<RecordType>) => void): Unsubscribe;
}

export interface UnauthorisedOperationDetails {
  userId: string | undefined;
  token: string | undefined;
  collectionName: string;
  operation: 'upsert' | 'remove';
}

export interface GetRequest {
  collectionName: string;
  ids: string[];
}

export interface GetAllRequest {
  collectionName: string;
}

export type GetResponse = string[];

export interface DistinctProps<RecordType extends Record = Record, Key extends keyof RecordType = keyof RecordType> {
  field: Key;
  filters?: DataFilters<RecordType>;
  sorts?: DataSorts<RecordType>;
  disable?: boolean;
}

export type DistinctResults<RecordType extends Record, Key extends keyof RecordType = keyof RecordType> = RecordType[Key][];

export interface DistinctRequest<RecordType extends Record = Record> extends DistinctProps<RecordType> {
  collectionName: string;
}

export type DistinctResponse = string;

export { UseSeedCollection };

// Legacy — kept for backward compatibility with existing change stream hooks
export interface MXDBOnUpsertChangeEvent {
  type: 'insert' | 'update';
  records: Record[];
}

export interface MXDBOnDeleteChangeEvent {
  type: 'delete';
  recordIds: string[];
}

export type MXDBOnChangeEvent = MXDBOnUpsertChangeEvent | MXDBOnDeleteChangeEvent;
