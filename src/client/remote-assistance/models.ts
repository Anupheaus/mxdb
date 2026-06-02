export type RemoteSqlMutatingRequestInfo = {
  /** Source system that initiated the request. */
  requestedBy: 'mcp';
  /** Operator identity supplied by the MCP caller (e.g. email/username). */
  operator: string;
};

export type MXDBRemoteAssistanceConfig = {
  onRemoteMutatingSqlRequested?: (info: RemoteSqlMutatingRequestInfo) => Promise<boolean>;
};

