import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'socket.io';
import type { ClientS2CState } from '../../src/server/startAuthenticatedServer';
import { registerMcpRoutes } from '../../src/server/mcp/McpRouter';

function startHttp(app: Koa): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app.callback());
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function mcpCall(url: string, body: unknown) {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-key',
      // Koa ctx.ip is ::1 locally; force an IPv4 forwarded ip that our allowlist supports.
      'x-forwarded-for': '127.0.0.1',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('MCP HTTP endpoint', () => {
  const oldEnv = { ...process.env };
  let server: Server | null = null;
  let url = '';

  beforeAll(async () => {
    process.env.MXDB_MCP_API_KEY = 'test-key';
    process.env.MXDB_MCP_IP_ALLOWLIST = '127.0.0.1/32';

    const clientS2CInstances = new Map<Socket, ClientS2CState>();

    const app = new Koa();
    app.proxy = true;
    app.use(bodyParser());
    const router = new Router();
    registerMcpRoutes(router as any, { clientS2CInstances });
    app.use(router.routes());
    app.use(router.allowedMethods());

    const started = await startHttp(app);
    server = started.server;
    url = started.url;

    // Register a fake connected socket
    const socket = { id: 'socket-1' } as unknown as Socket;
    clientS2CInstances.set(socket, {
      s2c: {} as any,
      emitAdminSqlQuery: async req => ({
        requestId: req.requestId,
        rows: [{ ok: 1 }],
        elapsedMs: 1,
      }),
    });
  });

  afterAll(async () => {
    process.env = oldEnv;
    await new Promise<void>(resolve => server?.close(() => resolve()));
  });

  it('responds to initialize', async () => {
    const { status, json } = await mcpCall(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(status).toBe(200);
    expect(json.result?.capabilities?.tools).toEqual({});
  });

  it('lists tools', async () => {
    const { status, json } = await mcpCall(url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(status).toBe(200);
    expect(json.result?.tools?.length).toBeGreaterThan(0);
  });

  it('dispatches mxdb_clients_list', async () => {
    const { status, json } = await mcpCall(url, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'mxdb_clients_list', arguments: {} },
    });
    expect(status).toBe(200);
    expect(Array.isArray(json.result)).toBe(true);
  });

  it('dispatches mxdb_client_sqlite_query to client', async () => {
    const { status, json } = await mcpCall(url, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'mxdb_client_sqlite_query',
        arguments: { socketId: 'socket-1', sql: 'select 1' },
      },
    });
    expect(status).toBe(200);
    expect(json.result?.rows).toEqual([{ ok: 1 }]);
  });

  it('rejects without auth', async () => {
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });
});

