import type { Socket } from 'socket.io';
import type { Logger } from '@anupheaus/common';
import type { MXDBRemoteSqliteQueryResponse } from '../../common/mcpModels';
import { listConnectedClients } from '../startAuthenticatedServer';
import type { ClientS2CState } from '../startAuthenticatedServer';

export type McpToolDescriptor = Readonly<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}>;

export type McpTools = Readonly<{
  listTools: () => McpToolDescriptor[];
  callTool: (input: { name: string; arguments: unknown }) => Promise<unknown>;
}>;

export type CreateMcpToolsInput = Readonly<{
  logger?: Logger;
  clientS2CInstances: Map<Socket, ClientS2CState>;
  listClients?: typeof listConnectedClients;
  defaultTimeoutMs?: number;
}>;

type SqliteQueryArgs = Readonly<{
  socketId: string;
  sql: string;
  params?: unknown[];
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function parseSqliteQueryArgs(raw: unknown): SqliteQueryArgs {
  if (!isPlainObject(raw)) throw new Error('invalid_arguments');
  const socketId = raw.socketId;
  const sql = raw.sql;
  const params = raw.params;

  if (typeof socketId !== 'string' || socketId.length === 0) throw new Error('invalid_socketId');
  if (typeof sql !== 'string' || sql.length === 0) throw new Error('invalid_sql');
  if (params != null && !Array.isArray(params)) throw new Error('invalid_params');

  return { socketId, sql, params: Array.isArray(params) ? params : undefined };
}

function findClientStateBySocketId(
  clientS2CInstances: Map<Socket, ClientS2CState>,
  socketId: string,
): { socket: Socket; state: ClientS2CState } | undefined {
  for (const [socket, state] of clientS2CInstances.entries()) {
    if (socket.id === socketId) return { socket, state };
  }
  return undefined;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeoutMessage: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        t = setTimeout(() => reject(new Error(onTimeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

export function createMcpTools(input: CreateMcpToolsInput): McpTools {
  const listClients = input.listClients ?? listConnectedClients;
  const defaultTimeoutMs = input.defaultTimeoutMs ?? 10_000;

  const tools: McpToolDescriptor[] = [
    {
      name: 'mxdb_clients_list',
      description: 'List connected MXDB clients (socket ids + auth metadata).',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    },
    {
      name: 'mxdb_client_sqlite_query',
      description: "Execute SQL on a client's local SQLite database.",
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          socketId: { type: 'string' },
          sql: { type: 'string' },
          params: { type: 'array' },
        },
        required: ['socketId', 'sql'],
      },
    },
  ];

  return {
    listTools: () => tools,
    callTool: async ({ name, arguments: args }) => {
      if (name === 'mxdb_clients_list') return listClients();

      if (name === 'mxdb_client_sqlite_query') {
        const parsed = parseSqliteQueryArgs(args);
        const found = findClientStateBySocketId(input.clientS2CInstances, parsed.socketId);
        if (!found) throw new Error('socket_not_found');

        input.logger?.info('[MCP] mxdb_client_sqlite_query dispatch', {
          socketId: parsed.socketId,
          hasParams: parsed.params != null,
        });

        const req = {
          requestId: `mcp-${Math.random().toString(16).slice(2)}`,
          sql: parsed.sql,
          params: parsed.params,
        };

        const res = await withTimeout(
          found.state.emitAdminSqlQuery(req) as Promise<MXDBRemoteSqliteQueryResponse>,
          defaultTimeoutMs,
          'MXDB_REMOTE_SQL_TIMEOUT',
        );

        return res;
      }

      throw new Error('tool_not_found');
    },
  };
}

