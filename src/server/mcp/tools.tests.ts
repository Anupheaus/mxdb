import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import type { ClientS2CState, ConnectedClientInfo } from '../startAuthenticatedServer';
import { createMcpTools } from './tools';
import type { MXDBRemoteSqliteQueryRequest, MXDBRemoteSqliteQueryResponse } from '../../common/mcpModels';

describe('createMcpTools', () => {
  it('lists the expected tools', () => {
    const tools = createMcpTools({
      clientS2CInstances: new Map(),
      listClients: () => [],
    });

    expect(tools.listTools().map(t => t.name)).toEqual([
      'mxdb_clients_list',
      'mxdb_client_sqlite_query',
    ]);
  });

  it('mxdb_clients_list returns injected listConnectedClients()', async () => {
    const listClients = vi.fn<[], ConnectedClientInfo[]>(() => [{ socketId: 's1' }]);
    const tools = createMcpTools({
      clientS2CInstances: new Map(),
      listClients,
    });

    await expect(tools.callTool({ name: 'mxdb_clients_list', arguments: {} })).resolves.toEqual([
      { socketId: 's1' },
    ]);
    expect(listClients).toHaveBeenCalledTimes(1);
  });

  it('mxdb_client_sqlite_query dispatches to the matched socket state', async () => {
    const socket = { id: 'abc' } as unknown as Socket;
    const emitAdminSqlQuery = vi.fn<
      [MXDBRemoteSqliteQueryRequest],
      Promise<MXDBRemoteSqliteQueryResponse>
    >(async () => ({ requestId: 'r1', rows: [], elapsedMs: 1 }));

    const clientS2CInstances = new Map<Socket, ClientS2CState>([
      [
        socket,
        {
          s2c: {} as never,
          emitAdminSqlQuery,
        },
      ],
    ]);

    const tools = createMcpTools({
      clientS2CInstances,
      listClients: () => [],
    });

    await expect(
      tools.callTool({
        name: 'mxdb_client_sqlite_query',
        arguments: { socketId: 'abc', sql: 'select 1', params: [1], requestedBy: 'tester' },
      }),
    ).resolves.toMatchObject({ rows: [], elapsedMs: 1 });

    expect(emitAdminSqlQuery).toHaveBeenCalledTimes(1);
    expect(emitAdminSqlQuery).toHaveBeenCalledWith(expect.objectContaining({ sql: 'select 1', params: [1] }));
  });

  it('mxdb_client_sqlite_query times out with MXDB_REMOTE_SQL_TIMEOUT', async () => {
    const socket = { id: 'abc' } as unknown as Socket;
    const emitAdminSqlQuery = vi.fn<
      [MXDBRemoteSqliteQueryRequest],
      Promise<MXDBRemoteSqliteQueryResponse>
    >(() => new Promise(() => undefined) as Promise<MXDBRemoteSqliteQueryResponse>);

    const clientS2CInstances = new Map<Socket, ClientS2CState>([
      [
        socket,
        {
          s2c: {} as never,
          emitAdminSqlQuery,
        },
      ],
    ]);

    const tools = createMcpTools({
      clientS2CInstances,
      listClients: () => [],
      defaultTimeoutMs: 5,
    });

    await expect(
      tools.callTool({
        name: 'mxdb_client_sqlite_query',
        arguments: { socketId: 'abc', sql: 'select 1', requestedBy: 'tester' },
      }),
    ).rejects.toThrowError('MXDB_REMOTE_SQL_TIMEOUT');
  });
});

