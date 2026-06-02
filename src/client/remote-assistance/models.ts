export type RemoteSqlMutatingRequestInfo = {
  sql: string;
  params?: unknown[];
  requestedBy: 'mcp';
};

export type MXDBRemoteAssistanceConfig = {
  onRemoteMutatingSqlRequested?: (info: RemoteSqlMutatingRequestInfo) => Promise<boolean>;
};

