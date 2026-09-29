// ─── Requests (main thread → worker) ─────────────────────────────────────────

export interface OpenRequest {
  type: 'open';
  correlationId: string;
  dbName: string;
  /** DDL statements to run on open (CREATE TABLE IF NOT EXISTS, etc.) */
  statements: string[];
  /**
   * Raw 256-bit AES-GCM key bytes derived from WebAuthn PRF.
   * When present the worker encrypts/decrypts the OPFS file with AES-GCM.
   * Omit (or pass `undefined`) for an unencrypted database.
   */
  encryptionKey?: Uint8Array;
}

export interface ExecRequest {
  type: 'exec';
  correlationId: string;
  sql: string;
  params?: unknown[];
  /** Collection name — used by SharedWorker to broadcast cross-tab change notifications. */
  collectionHint?: string;
}

/** Run multiple statements inside a single transaction (commit or rollback together). */
export interface ExecBatchRequest {
  type: 'exec-batch';
  correlationId: string;
  statements: Array<{ sql: string; params?: unknown[] }>;
  /** Collection name — used by SharedWorker to broadcast cross-tab change notifications. */
  collectionHint?: string;
}

export interface QueryRequest {
  type: 'query';
  correlationId: string;
  sql: string;
  params?: unknown[];
}

/** Run multiple SELECT queries in a single worker round-trip. Returns an array of row arrays, one per query. */
export interface QueryMultiRequest {
  type: 'query-multi';
  correlationId: string;
  queries: Array<{ sql: string; params?: unknown[] }>;
}

/** Persist the encrypted database now if it has unflushed writes (sent when a tab is hidden or unloads, sc-680). */
export interface FlushRequest {
  type: 'flush';
  correlationId: string;
}

export interface CloseRequest {
  type: 'close';
  correlationId: string;
}

/** Sent by a tab on connect so the SharedWorker can assign it a portId. */
export interface ConnectRequest {
  type: 'connect';
  correlationId: string;
}

/** Sent by a tab on graceful close so the SharedWorker can drop its port entry. */
export interface DisconnectRequest {
  type: 'disconnect';
  portId: string;
}

export type WorkerRequest =
  | OpenRequest
  | ExecRequest
  | ExecBatchRequest
  | QueryRequest
  | QueryMultiRequest
  | CloseRequest
  | FlushRequest
  | ConnectRequest
  | DisconnectRequest;

export type WorkerRequestWithCorrelationId = Exclude<WorkerRequest, DisconnectRequest>;

// ─── Responses (worker → main thread) ────────────────────────────────────────

export interface WorkerSuccessResponse {
  correlationId: string;
  result: unknown;   // rows[] for query, null for exec/open/close
  error?: never;
}

export interface WorkerErrorResponse {
  correlationId: string;
  error: string;
  result?: never;
}

export type WorkerResponse = WorkerSuccessResponse | WorkerErrorResponse;
