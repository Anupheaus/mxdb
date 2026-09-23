// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@anupheaus/common';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SyncStateContext, type SyncStateContextValue } from './providers/client-to-server/SyncStateContext';
import { DbsContext, type DbContextProps, type DbsContextProps } from './providers/dbs/DbContext';
import { MxdbReadyContext, type MxdbReadyContextProps } from './auth/MxdbReadyContext';

// ─── Controllable socket boundary ─────────────────────────────────────────────

interface FakeSocket {
  id: string;
}

const { nexus } = vi.hoisted(() => ({
  nexus: {
    isConnected: false,
    socket: undefined as FakeSocket | undefined,
    listener: undefined as ((isConnected: boolean, socket: FakeSocket | undefined) => void) | undefined,
    connect: () => undefined,
    disconnect: () => undefined,
  },
}));

vi.mock('@anupheaus/nexus/client', () => ({
  useNexus: () => ({
    getIsConnected: () => nexus.isConnected,
    getSocket: () => nexus.socket,
    onConnectionStateChanged: (listener: (isConnected: boolean, socket: FakeSocket | undefined) => void) => { nexus.listener = listener; },
    connect: nexus.connect,
    disconnect: nexus.disconnect,
  }),
}));

const { useMXDB } = await import('./useMXDB');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Harness ──────────────────────────────────────────────────────────────────

type UseMXDBResult = ReturnType<typeof useMXDB>;
type Reader = (result: UseMXDBResult) => unknown;

interface Contexts {
  syncState?: SyncStateContextValue;
  dbs?: DbsContextProps;
  ready?: MxdbReadyContextProps;
}

const observed = { value: undefined as unknown, result: undefined as UseMXDBResult | undefined };

function Probe({ read }: { read: Reader }): null {
  const result = useMXDB();
  observed.result = result;
  observed.value = read(result);
  return null;
}

let root: Root;

function render(read: Reader, { syncState, dbs, ready }: Contexts = {}): void {
  act(() => {
    root.render(
      <SyncStateContext.Provider value={syncState ?? { isSyncing: false, onSyncStateChanged: () => () => undefined }}>
        <DbsContext.Provider value={dbs ?? { dbs: new Map() }}>
          <MxdbReadyContext.Provider value={ready ?? { waitForDbReady: () => Promise.resolve(false), getIsDbReady: () => false }}>
            <Probe read={read} />
          </MxdbReadyContext.Provider>
        </DbsContext.Provider>
      </SyncStateContext.Provider>,
    );
  });
}

function changeConnection(isConnected: boolean, socket?: FakeSocket): void {
  act(() => nexus.listener?.(isConnected, socket));
}

beforeEach(() => {
  nexus.isConnected = false;
  nexus.socket = undefined;
  nexus.listener = undefined;
  observed.value = undefined;
  observed.result = undefined;
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
});

// ─── Connection state ─────────────────────────────────────────────────────────

describe('useMXDB connection state', () => {
  const initialStates: [string, boolean, FakeSocket | undefined, boolean, string | undefined][] = [
    ['connected', true, { id: 'socket-1' }, true, 'socket-1'],
    ['disconnected', false, { id: 'socket-1' }, false, undefined],
  ];

  it.each(initialStates)('reports the initial %s state', (_label, isConnected, socket, expectedConnected, expectedClientId) => {
    nexus.isConnected = isConnected;
    nexus.socket = socket;

    render(({ isConnected: connected, clientId }) => ({ connected, clientId }));

    expect(observed.value).toEqual({ connected: expectedConnected, clientId: expectedClientId });
  });

  it('re-renders with the new state and client id when the connection comes up', () => {
    render(({ isConnected, clientId }) => ({ isConnected, clientId }));

    changeConnection(true, { id: 'socket-2' });

    expect(observed.value).toEqual({ isConnected: true, clientId: 'socket-2' });
  });

  it('clears the client id when the connection drops', () => {
    nexus.isConnected = true;
    nexus.socket = { id: 'socket-1' };
    render(({ isConnected, clientId }) => ({ isConnected, clientId }));

    changeConnection(false, undefined);

    expect(observed.value).toEqual({ isConnected: false, clientId: undefined });
  });

  it('exposes the socket connect and disconnect controls', () => {
    render(() => undefined);

    expect({ connect: observed.result?.connect, disconnect: observed.result?.disconnect })
      .toEqual({ connect: nexus.connect, disconnect: nexus.disconnect });
  });
});

// ─── Synchronising state ──────────────────────────────────────────────────────

describe('useMXDB synchronising state', () => {
  function makeSyncState(isSyncing: boolean) {
    const listeners = new Set<(value: boolean) => void>();
    const syncState: SyncStateContextValue = {
      isSyncing,
      onSyncStateChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const emit = (value: boolean) => act(() => { for (const listener of listeners) listener(value); });
    return { syncState, emit };
  }

  it.each([true, false])('reports the initial synchronising state (%s)', isSyncing => {
    render(({ isSynchronising }) => isSynchronising, { syncState: makeSyncState(isSyncing).syncState });

    expect(observed.value).toBe(isSyncing);
  });

  it('re-renders when synchronisation starts', () => {
    const { syncState, emit } = makeSyncState(false);
    render(({ isSynchronising }) => isSynchronising, { syncState });

    emit(true);

    expect(observed.value).toBe(true);
  });
});

// ─── Database readiness ───────────────────────────────────────────────────────

describe('useMXDB database readiness', () => {
  const openDb = { dbs: new Map<string, DbContextProps>([['app', {} as DbContextProps]]), lastDb: 'app' };

  const cases: [string, boolean, boolean, DbsContextProps][] = [
    ['the encryption key is ready', true, true, { dbs: new Map() }],
    ['the last opened database is registered', true, false, openDb],
    ['no database has been opened', false, false, { dbs: new Map() }],
    ['the last opened database is no longer registered', false, false, { dbs: new Map(), lastDb: 'app' }],
  ];

  it.each(cases)('when %s, reports ready=%s', (_label, expected, isKeyReady, dbs) => {
    render(({ isDbReady }) => isDbReady, { dbs, ready: { waitForDbReady: () => Promise.resolve(isKeyReady), getIsDbReady: () => isKeyReady } });

    expect(observed.value).toBe(expected);
  });

  it('waits for readiness through the ready context', async () => {
    render(() => undefined, { ready: { waitForDbReady: () => Promise.resolve(true), getIsDbReady: () => false } });

    await expect(observed.result!.waitForDbReady()).resolves.toBe(true);
  });
});
