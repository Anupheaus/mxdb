// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SyncPausedError, type ClientReceiver, type MXDBRecordCursors, type MXDBSyncEngineResponse } from '../../../common/sync-engine';
import { mxdbAdminClientSqlQueryAction, mxdbServerToClientSyncAction } from '../../../common';
import type { MXDBRemoteSqliteQueryRequest } from '../../../common/mcpModels';
import { ClientReceiverContext } from './ClientReceiverContext';

// ─── Controllable boundaries ──────────────────────────────────────────────────

type ActionHandler = (payload: unknown) => Promise<unknown>;

const { handlers, loggerWarn, loggerError, fakeDb, remoteQuery } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => Promise<unknown>>(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  fakeDb: { name: 'local-db' },
  remoteQuery: vi.fn(),
}));

vi.mock('@anupheaus/nexus/client', () => ({
  useServerActionHandler: ({ name }: { name: string }) => (handler: ActionHandler) => { handlers.set(name, handler); },
}));

vi.mock('@anupheaus/react-ui', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createComponent: (_name: string, component: unknown) => component,
  useLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: loggerWarn, error: loggerError, silly: vi.fn() }),
}));

vi.mock('../dbs/useDb', () => ({ useDb: () => ({ db: fakeDb, collections: [] }) }));

vi.mock('../../remote-assistance/remoteSqliteHandler', () => ({ handleRemoteSqliteQuery: remoteQuery }));

const { ServerToClientProvider } = await import('./ServerToClientProvider');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PAYLOAD: MXDBRecordCursors = [{ collectionName: 'items', records: [{ recordId: 'r1', lastAuditEntryId: 'u1' }] }];

let root: Root;

function render(clientReceiver: ClientReceiver | null): void {
  act(() => {
    root.render(
      <ClientReceiverContext.Provider value={clientReceiver}>
        <ServerToClientProvider />
      </ClientReceiverContext.Provider>,
    );
  });
}

function receiverThatProcesses(process: (payload: MXDBRecordCursors) => MXDBSyncEngineResponse): ClientReceiver {
  return { process: vi.fn(process) } as unknown as ClientReceiver;
}

function syncHandler(): ActionHandler {
  return handlers.get(mxdbServerToClientSyncAction.name)!;
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
});

// ─── S2C sync handler ─────────────────────────────────────────────────────────

describe('ServerToClientProvider S2C sync handler', () => {
  it('returns the client receiver response for a server push', async () => {
    const response: MXDBSyncEngineResponse = [{ collectionName: 'items', successfulRecordIds: ['r1'] }];
    render(receiverThatProcesses(() => response));

    await expect(syncHandler()(PAYLOAD)).resolves.toEqual(response);
  });

  it('passes the server payload to the client receiver unchanged', async () => {
    const receiver = receiverThatProcesses(() => []);
    render(receiver);

    await syncHandler()(PAYLOAD);

    expect(receiver.process).toHaveBeenCalledWith(PAYLOAD);
  });

  it('acknowledges nothing when the client receiver is not yet available', async () => {
    render(null);

    await expect(syncHandler()(PAYLOAD)).resolves.toEqual([]);
  });

  it('warns that the push was dropped when the client receiver is not yet available', async () => {
    render(null);

    await syncHandler()(PAYLOAD);

    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('dropping'));
  });

  it('signals the paused sentinel to the server while a client dispatch is in flight', async () => {
    render(receiverThatProcesses(() => { throw new SyncPausedError(); }));

    await expect(syncHandler()(PAYLOAD)).rejects.toThrow('MXDB_SYNC_PAUSED');
  });

  it('rethrows any other processing failure unchanged', async () => {
    const failure = new Error('apply failed');
    render(receiverThatProcesses(() => { throw failure; }));

    await expect(syncHandler()(PAYLOAD)).rejects.toBe(failure);
  });

  it('logs non-pause processing failures', async () => {
    render(receiverThatProcesses(() => { throw new Error('apply failed'); }));

    await syncHandler()(PAYLOAD).catch(() => undefined);

    expect(loggerError).toHaveBeenCalledWith('S2C process failed', expect.anything());
  });
});

// ─── Remote SQL handler ───────────────────────────────────────────────────────

describe('ServerToClientProvider remote SQL handler', () => {
  it('runs the remote query against the local database and returns its result', async () => {
    const request = { sql: 'select 1', requestId: 'q1', requestedBy: 'operator' } as MXDBRemoteSqliteQueryRequest;
    const result = { requestId: 'q1', rows: [], elapsedMs: 1 };
    remoteQuery.mockResolvedValue(result);
    render(receiverThatProcesses(() => []));

    const response = await handlers.get(mxdbAdminClientSqlQueryAction.name)!(request);

    expect({ response, args: remoteQuery.mock.calls[0]?.slice(0, 2) }).toEqual({ response: result, args: [fakeDb, request] });
  });
});
