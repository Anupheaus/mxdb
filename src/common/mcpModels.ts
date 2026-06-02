export type MXDBRemoteSqliteQueryRequest = {
  requestId: string;
  sql: string;
  params?: unknown[];
  maxRows?: number;
  timeoutMs?: number;
};

export type MXDBRemoteSqliteQueryResponse = {
  requestId: string;
  rows: Record<string, unknown>[];
  truncated?: boolean;
  elapsedMs: number;
  error?: { message: string };
};

