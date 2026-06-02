import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import type { ClientS2CState } from '../startAuthenticatedServer';
import { dispatchMcpJsonRpc } from './McpRouter';

describe('dispatchMcpJsonRpc', () => {
  const clientS2CInstances = new Map<Socket, ClientS2CState>();

  it('returns error for invalid request shape', async () => {
    await expect(
      dispatchMcpJsonRpc({ requestBody: null, clientS2CInstances }),
    ).resolves.toMatchObject({ error: { code: -32600 } });
  });

  it('supports initialize', async () => {
    await expect(
      dispatchMcpJsonRpc({
        requestBody: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        clientS2CInstances,
      }),
    ).resolves.toMatchObject({
      result: { serverInfo: { name: 'mxdb' }, capabilities: { tools: {} } },
    });
  });

  it('supports tools/list', async () => {
    const res = await dispatchMcpJsonRpc({
      requestBody: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      clientS2CInstances,
    });
    expect(res).toMatchObject({ result: { tools: expect.any(Array) } });
  });

  it('returns Method not found for unsupported methods', async () => {
    await expect(
      dispatchMcpJsonRpc({
        requestBody: { jsonrpc: '2.0', id: 1, method: 'nope' },
        clientS2CInstances,
      }),
    ).resolves.toMatchObject({ error: { code: -32601 } });
  });
});

