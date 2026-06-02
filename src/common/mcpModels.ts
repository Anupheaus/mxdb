export type MXDBRemoteSqliteQueryRequest = {
  requestId: string;
  sql: string;
  params?: unknown[];
  /**
   * Operator identity provided by the MCP caller (e.g. an email, username, or system name).
   * Used for client-side consent prompts and audit logging.
   */
  requestedBy: string;
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

