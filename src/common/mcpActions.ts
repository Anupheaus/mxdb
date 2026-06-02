import { defineAction } from '@anupheaus/nexus/common';
import type { MXDBRemoteSqliteQueryRequest, MXDBRemoteSqliteQueryResponse } from './mcpModels';

/**
 * Server→client request to execute SQL against the client's local SQLite DB.
 * Used by the MCP remote assistance tooling.
 */
export const mxdbAdminClientSqlQueryAction =
  defineAction<MXDBRemoteSqliteQueryRequest, MXDBRemoteSqliteQueryResponse>()('mxdbAdminClientSqlQueryAction');

