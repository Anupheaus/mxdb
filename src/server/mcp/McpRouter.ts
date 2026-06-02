import type Router from 'koa-router';
import type { Logger } from '@anupheaus/common';
import type { Socket } from 'socket.io';
import { isMcpAuthorized } from './mcpAuth';
import type { ClientS2CState } from '../startAuthenticatedServer';
import { createMcpTools } from './tools';

type JsonRpcId = string | number | null;

type JsonRpcRequest = Readonly<{
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}>;

type JsonRpcSuccess = Readonly<{
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}>;

type JsonRpcError = Readonly<{
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function parseJsonRpcRequest(raw: unknown): JsonRpcRequest | { error: JsonRpcError } {
  if (!isPlainObject(raw))
    return { error: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };

  const jsonrpc = raw.jsonrpc;
  const id = raw.id as JsonRpcId;
  const method = raw.method;
  const params = raw.params;

  if (jsonrpc !== '2.0' || typeof method !== 'string' || method.length === 0) {
    return { error: { jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' || id === null ? id : null, error: { code: -32600, message: 'Invalid Request' } } };
  }

  const safeId =
    typeof id === 'string' || typeof id === 'number' || id === null ? id : null;
  return { jsonrpc: '2.0', id: safeId, method, params };
}

export async function dispatchMcpJsonRpc(
  input: Readonly<{
    requestBody: unknown;
    logger?: Logger;
    clientS2CInstances: Map<Socket, ClientS2CState>;
  }>,
): Promise<JsonRpcSuccess | JsonRpcError> {
  const parsed = parseJsonRpcRequest(input.requestBody);
  if ('error' in parsed) return parsed.error;

  const tools = createMcpTools({
    logger: input.logger,
    clientS2CInstances: input.clientS2CInstances,
  });

  try {
    switch (parsed.method) {
      case 'initialize': {
        return {
          jsonrpc: '2.0',
          id: parsed.id,
          result: {
            serverInfo: { name: 'mxdb', version: '0.0.0' },
            capabilities: { tools: {} },
          },
        };
      }

      case 'tools/list': {
        return {
          jsonrpc: '2.0',
          id: parsed.id,
          result: { tools: tools.listTools() },
        };
      }

      case 'tools/call': {
        const params = parsed.params;
        if (!isPlainObject(params))
          return {
            jsonrpc: '2.0',
            id: parsed.id,
            error: { code: -32602, message: 'Invalid params' },
          };

        const name = params.name;
        const args = params.arguments;
        if (typeof name !== 'string' || name.length === 0)
          return {
            jsonrpc: '2.0',
            id: parsed.id,
            error: { code: -32602, message: 'Invalid params' },
          };

        const result = await tools.callTool({ name, arguments: args });
        return { jsonrpc: '2.0', id: parsed.id, result };
      }

      default:
        return {
          jsonrpc: '2.0',
          id: parsed.id,
          error: { code: -32601, message: 'Method not found' },
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error';
    const code =
      message === 'MXDB_REMOTE_SQL_TIMEOUT' ? -32000 :
      message === 'tool_not_found' ? -32601 :
      message.startsWith('invalid_') ? -32602 :
      message === 'socket_not_found' ? -32000 :
      -32000;

    return {
      jsonrpc: '2.0',
      id: parsed.id,
      error: { code, message },
    };
  }
}

export function registerMcpRoutes(
  router: Router,
  input: Readonly<{ logger?: Logger; clientS2CInstances: Map<Socket, ClientS2CState> }>,
): void {
  router.get('/mcp', async ctx => {
    ctx.status = 200;
    ctx.type = 'text/plain';
    ctx.body = 'MCP SSE not supported yet';
  });

  router.post('/mcp', async ctx => {
    const auth = isMcpAuthorized({
      ip: ctx.ip,
      authorizationHeader: ctx.headers.authorization,
      expectedApiKey: process.env.MXDB_MCP_API_KEY,
      ipAllowlist: process.env.MXDB_MCP_IP_ALLOWLIST,
    });
    if (!auth.ok) {
      ctx.status = auth.status;
      ctx.body = { error: auth.error };
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (ctx.request as any).body as unknown;
    const jsonRpcResponse = await dispatchMcpJsonRpc({
      requestBody: body,
      logger: input.logger,
      clientS2CInstances: input.clientS2CInstances,
    });

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = jsonRpcResponse;
  });
}

