// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@anupheaus/common'; // installs Object.clone used by the auditor
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Record as MXDBRecord } from '@anupheaus/common';
import type { MXDBError } from '../../../common';
import { AuditEntryType } from '../../../common/auditor';
import type {
  ClientDispatcherRequest,
  ClientReceiver,
  MXDBActiveRecordState,
  MXDBRecordCursors,
} from '../../../common/sync-engine';
import { useClientReceiver } from '../server-to-client/ClientReceiverContext';
import { useSyncState } from './SyncStateContext';

// ─── Controllable boundaries ──────────────────────────────────────────────────

interface FakeSyncProps {
  sendBatch(request: ClientDispatcherRequest): Promise<unknown>;
}

interface FakeSync {
  props: FakeSyncProps;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setDispatching(value: boolean): void;
}

const { syncs, nexus, sendBatchAction, startBehaviour } = vi.hoisted(() => ({
  syncs: [] as FakeSync[],
  /** When set, every sync engine start() rejects with this value. */
  startBehaviour: { rejectWith: undefined as unknown },
  nexus: {
    isConnected: true,
    connectionListener: undefined as ((isConnected: boolean) => void) | undefined,
  },
  sendBatchAction: vi.fn(),
}));

vi.mock('./ClientToServerSynchronisation', () => ({
  ClientToServerSynchronisation: class {
    constructor(props: FakeSyncProps) {
      this.props = props;
      syncs.push(this as unknown as FakeSync);
    }
    readonly props: FakeSyncProps;
    readonly start = vi.fn(() => (startBehaviour.rejectWith === undefined ? Promise.resolve() : Promise.reject(startBehaviour.rejectWith)));
    readonly stop = vi.fn();
    readonly close = vi.fn();
    readonly #listeners = new Set<(value: boolean) => void>();
    onDispatchingChanged(listener: (value: boolean) => void) {
      this.#listeners.add(listener);
      return () => { this.#listeners.delete(listener); };
    }
    setDispatching(value: boolean) {
      for (const listener of this.#listeners) listener(value);
    }
  },
}));

vi.mock('@anupheaus/nexus/client', () => ({
  useAction: () => ({ mxdbClientToServerSyncAction: sendBatchAction }),
  useNexus: () => ({
    getIsConnected: () => nexus.isConnected,
    onConnectionStateChanged: (listener: (isConnected: boolean) => void) => { nexus.connectionListener = listener; },
  }),
}));

vi.mock('@anupheaus/react-ui', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createComponent: (_name: string, component: unknown) => component,
  useLogger: () => {
    const logger: Record<string, unknown> = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() };
    logger.createSubLogger = () => logger;
    return logger;
  },
}));

// ─── Fake local database ──────────────────────────────────────────────────────

interface FakeCollection {
  states: Map<string, MXDBActiveRecordState>;
  batchApplyServerWriteSync: ReturnType<typeof vi.fn>;
  applyServerDeleteSync: ReturnType<typeof vi.fn>;
  getStatesSync(ids: string[]): MXDBActiveRecordState[];
}

function makeCollection(): FakeCollection {
  const states = new Map<string, MXDBActiveRecordState>();
  return {
    states,
    batchApplyServerWriteSync: vi.fn(),
    applyServerDeleteSync: vi.fn(),
    getStatesSync: ids => ids.flatMap(id => states.get(id) ?? []),
  };
}

function makeDb(collections: Record<string, FakeCollection>) {
  return {
    use(name: string) {
      const collection = collections[name];
      if (collection == null) throw new Error(`unknown collection ${name}`);
      return collection;
    },
  };
}

const { dbState } = vi.hoisted(() => ({ dbState: { current: undefined as unknown } }));
vi.mock('../dbs', () => ({ useDb: () => ({ db: dbState.current }) }));

const { ClientToServerSyncProvider } = await import('./ClientToServerSyncProvider');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Probes ───────────────────────────────────────────────────────────────────

const probe = {
  receiver: null as ClientReceiver | null,
  isSyncing: false,
  onSyncStateChanged: undefined as ((listener: (isSyncing: boolean) => void) => () => void) | undefined,
};

function Probe(): null {
  probe.receiver = useClientReceiver();
  const { isSyncing, onSyncStateChanged } = useSyncState();
  probe.isSyncing = isSyncing;
  probe.onSyncStateChanged = onSyncStateChanged;
  return null;
}

let root: Root;

async function render(db: unknown, onError?: (error: MXDBError) => void): Promise<void> {
  dbState.current = db;
  await act(async () => {
    root.render(
      <ClientToServerSyncProvider collections={[]} onError={onError}>
        <Probe />
      </ClientToServerSyncProvider>,
    );
  });
}

function latestSync(): FakeSync {
  return syncs[syncs.length - 1]!;
}

beforeEach(() => {
  syncs.length = 0;
  startBehaviour.rejectWith = undefined;
  nexus.isConnected = true;
  nexus.connectionListener = undefined;
  probe.receiver = null;
  probe.isSyncing = false;
  sendBatchAction.mockReset();
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
});

// ─── Connection lifecycle ─────────────────────────────────────────────────────

describe('ClientToServerSyncProvider connection lifecycle', () => {
  it('does not start syncing while disconnected at mount', async () => {
    nexus.isConnected = false;

    await render(makeDb({}));

    expect(latestSync().start).not.toHaveBeenCalled();
  });

  it('starts syncing when the connection comes up', async () => {
    nexus.isConnected = false;
    await render(makeDb({}));

    await act(async () => { nexus.connectionListener?.(true); });

    expect(latestSync().start).toHaveBeenCalledTimes(1);
  });

  it('stops syncing when the connection drops', async () => {
    await render(makeDb({}));

    await act(async () => { nexus.connectionListener?.(false); });

    expect(latestSync().stop).toHaveBeenCalledTimes(1);
  });

  it('reports a failed start at mount as a SYNC_FAILED error', async () => {
    const onError = vi.fn();
    const failure = new Error('handshake failed');
    startBehaviour.rejectWith = failure;

    await render(makeDb({}), onError);

    expect(onError).toHaveBeenCalledWith({ code: 'SYNC_FAILED', message: 'handshake failed', severity: 'error', originalError: failure });
  });

  it('reports a failed start on reconnect as a SYNC_FAILED error', async () => {
    nexus.isConnected = false;
    const onError = vi.fn();
    await render(makeDb({}), onError);
    startBehaviour.rejectWith = 'offline';

    await act(async () => { nexus.connectionListener?.(true); });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'SYNC_FAILED', message: 'offline' }));
  });

  it('closes the sync engine on unmount', async () => {
    await render(makeDb({}));
    const sync = latestSync();

    await act(async () => { root.unmount(); });
    root = createRoot(document.createElement('div'));

    expect(sync.close).toHaveBeenCalledTimes(1);
  });
});

// ─── Sync state ───────────────────────────────────────────────────────────────

describe('ClientToServerSyncProvider sync state', () => {
  it('reports not syncing initially', async () => {
    await render(makeDb({}));

    expect(probe.isSyncing).toBe(false);
  });

  it('reports syncing while the dispatcher is dispatching', async () => {
    await render(makeDb({}));

    await act(async () => { latestSync().setDispatching(true); });

    expect(probe.isSyncing).toBe(true);
  });

  it('notifies sync-state subscribers when dispatching changes', async () => {
    await render(makeDb({}));
    const observed: boolean[] = [];
    probe.onSyncStateChanged!(isSyncing => { observed.push(isSyncing); });

    await act(async () => { latestSync().setDispatching(true); });

    expect(observed).toEqual([true]);
  });
});

// ─── Outbound batches ─────────────────────────────────────────────────────────

describe('ClientToServerSyncProvider outbound batches', () => {
  it('sends batches through the client-to-server sync action', async () => {
    const request: ClientDispatcherRequest = [{ collectionName: 'items', records: [] }];
    sendBatchAction.mockResolvedValue([{ collectionName: 'items', successfulRecordIds: [] }]);
    await render(makeDb({}));

    await latestSync().props.sendBatch(request);

    expect(sendBatchAction).toHaveBeenCalledWith(request);
  });
});

// ─── Inbound pushes applied to the local database ─────────────────────────────

describe('ClientToServerSyncProvider applying server pushes', () => {
  const pushNewRecord = (collectionName: string, record: MXDBRecord): MXDBRecordCursors =>
    [{ collectionName, records: [{ record, lastAuditEntryId: '01SERVER' }] }];

  it('writes a record the client does not hold into the local collection', async () => {
    const items = makeCollection();
    await render(makeDb({ items }));

    probe.receiver!.process(pushNewRecord('items', { id: 'r1' }));

    expect(items.batchApplyServerWriteSync).toHaveBeenCalledWith([{ record: { id: 'r1' }, lastAuditEntryId: '01SERVER' }]);
  });

  it('acknowledges the records it wrote', async () => {
    await render(makeDb({ items: makeCollection() }));

    const response = probe.receiver!.process(pushNewRecord('items', { id: 'r1' }));

    expect(response).toEqual([{ collectionName: 'items', successfulRecordIds: ['r1'] }]);
  });

  it('applies a server delete to a record the client holds without pending changes', async () => {
    const items = makeCollection();
    items.states.set('r1', { record: { id: 'r1' }, audit: [{ type: AuditEntryType.Branched, id: '01ANCHOR' }] });
    await render(makeDb({ items }));

    probe.receiver!.process([{ collectionName: 'items', records: [{ recordId: 'r1', lastAuditEntryId: '01SERVER' }] }]);

    expect(items.applyServerDeleteSync).toHaveBeenCalledWith(['r1']);
  });
});
