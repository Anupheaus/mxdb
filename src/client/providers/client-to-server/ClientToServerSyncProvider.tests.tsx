// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// ── controllable collaborators ─────────────────────────────────────────────────

const { dbState, createdSyncs, mockGetIsConnected } = vi.hoisted(() => ({
  dbState: { current: { id: 'db-1' } as unknown },
  createdSyncs: [] as any[],
  mockGetIsConnected: vi.fn(() => true),
}));

vi.mock('../dbs', () => ({ useDb: () => ({ db: dbState.current }) }));

vi.mock('@anupheaus/nexus/client', () => ({
  useAction: () => ({ mxdbClientToServerSyncAction: vi.fn() }),
  useNexus: () => ({ onConnectionStateChanged: vi.fn(), getIsConnected: mockGetIsConnected }),
}));

vi.mock('@anupheaus/react-ui', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createComponent: (_name: string, component: unknown) => component,
  useLogger: () => {
    const logger: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() };
    logger.createSubLogger = () => logger;
    return logger;
  },
}));

vi.mock('./ClientToServerSynchronisation', () => ({
  ClientToServerSynchronisation: class {
    getDb: () => unknown;
    start = vi.fn(async () => undefined);
    close = vi.fn();
    onDispatchingChanged = vi.fn(() => () => undefined);
    constructor({ getDb }: { getDb: () => unknown }) {
      this.getDb = getDb;
      createdSyncs.push(this);
    }
  },
}));

const { ClientToServerSyncProvider } = await import('./ClientToServerSyncProvider');

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;

async function renderWithDb(db: unknown): Promise<void> {
  dbState.current = db;
  await act(async () => { root.render(React.createElement(ClientToServerSyncProvider as any, { collections: [] })); });
}

describe('ClientToServerSyncProvider when DbsProvider swaps the Db instance', () => {
  beforeEach(() => {
    createdSyncs.length = 0;
    mockGetIsConnected.mockReturnValue(true);
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => { await act(async () => { root.unmount(); }); });

  it('rebuilds the sync engine against the NEW Db, closes the old one and starts the new one', async () => {
    const firstDb = { id: 'db-1' };
    const secondDb = { id: 'db-2' };
    await renderWithDb(firstDb);
    expect(createdSyncs).toHaveLength(1);
    expect(createdSyncs[0].getDb()).toBe(firstDb);

    await renderWithDb(secondDb);

    expect(createdSyncs).toHaveLength(2);
    expect(createdSyncs[1].getDb()).toBe(secondDb);
    expect(createdSyncs[0].close).toHaveBeenCalled();
    expect(createdSyncs[1].start).toHaveBeenCalled();
  });

  it('keeps the same engine across re-renders with the same Db', async () => {
    const db = { id: 'db-1' };
    await renderWithDb(db);
    await renderWithDb(db);

    expect(createdSyncs).toHaveLength(1);
    expect(createdSyncs[0].close).not.toHaveBeenCalled();
  });
});
