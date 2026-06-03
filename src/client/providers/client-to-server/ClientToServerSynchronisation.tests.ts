import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@anupheaus/common';

let capturedCdProps: any;
const mockCdStart = vi.fn();
const mockCdStop = vi.fn();
const mockCdEnqueue = vi.fn();

vi.mock('../../../common/sync-engine', async (importOriginal) => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    ClientDispatcher: class {
      constructor(_logger: unknown, props: unknown) {
        capturedCdProps = props;
      }
      start = mockCdStart;
      stop = mockCdStop;
      enqueue = mockCdEnqueue;
    },
  };
});

import { ClientToServerSynchronisation } from './ClientToServerSynchronisation';

const logger = new Logger('test');

const collections = [{ name: 'items' }, { name: 'orders' }] as any[];

function makeDb(overrides?: {
  whenReady?: () => Promise<void>;
  getPendingStatesSync?: () => any[];
  getAllStatesSync?: () => any[];
  getStatesSync?: (ids: string[]) => any[];
  collapseAuditSync?: ReturnType<typeof vi.fn>;
  applyServerDeleteSync?: ReturnType<typeof vi.fn>;
}) {
  const col = {
    whenReady: overrides?.whenReady ?? (() => Promise.resolve()),
    getPendingStatesSync: overrides?.getPendingStatesSync ?? (() => []),
    getAllStatesSync: overrides?.getAllStatesSync ?? (() => []),
    getStatesSync: overrides?.getStatesSync ?? ((_: string[]) => []),
    collapseAuditSync: overrides?.collapseAuditSync ?? vi.fn(),
    applyServerDeleteSync: overrides?.applyServerDeleteSync ?? vi.fn(),
  };
  return { use: (_name: string) => col };
}

function makeC2S(db: any) {
  return new ClientToServerSynchronisation({
    clientReceiver: {} as any,
    sendBatch: vi.fn().mockResolvedValue([]),
    getDb: () => db,
    collections,
    logger,
  });
}

describe('ClientToServerSynchronisation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCdProps = undefined;
  });

  it('start calls cd.start after collections are ready', async () => {
    const resolvers: Array<() => void> = [];
    const whenReady = () => new Promise<void>(resolve => { resolvers.push(resolve); });
    const db = makeDb({ whenReady });
    const c2s = makeC2S(db);

    const startPromise = c2s.start();
    expect(mockCdStart).not.toHaveBeenCalled();

    // Resolve all collection whenReady() promises (one per collection in the array)
    resolvers.forEach(resolve => resolve());
    await startPromise;
    expect(mockCdStart).toHaveBeenCalledOnce();
  });

  it('start is idempotent', async () => {
    const db = makeDb();
    const c2s = makeC2S(db);

    await c2s.start();
    await c2s.start();

    expect(mockCdStart).toHaveBeenCalledOnce();
  });

  it('stop calls cd.stop', async () => {
    const db = makeDb();
    const c2s = makeC2S(db);

    await c2s.start();
    c2s.stop();

    expect(mockCdStop).toHaveBeenCalledOnce();
  });

  it('stop before start is a no-op', () => {
    const db = makeDb();
    const c2s = makeC2S(db);

    c2s.stop();

    expect(mockCdStop).not.toHaveBeenCalled();
  });

  it('enqueue delegates to ClientDispatcher.enqueue', () => {
    const db = makeDb();
    const c2s = makeC2S(db);

    c2s.enqueue('items', 'r1');

    expect(mockCdEnqueue).toHaveBeenCalledOnce();
    expect(mockCdEnqueue).toHaveBeenCalledWith({ collectionName: 'items', recordId: 'r1' });
  });

  it('pendingQueueEntryCount sums pending states across collections', () => {
    const db = makeDb({ getPendingStatesSync: () => [{}] });
    const c2s = makeC2S(db);

    // Two collections, each returning 1 pending state
    expect(c2s.pendingQueueEntryCount).toBe(2);
  });

  it('onDispatchingChanged notifies listeners', () => {
    const db = makeDb();
    const c2s = makeC2S(db);
    const listener = vi.fn();

    c2s.onDispatchingChanged(listener);
    capturedCdProps.onDispatching(true);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(true);
  });

  it('isDispatching reflects state', () => {
    const db = makeDb();
    const c2s = makeC2S(db);

    expect(c2s.isDispatching).toBe(false);
    capturedCdProps.onDispatching(true);
    expect(c2s.isDispatching).toBe(true);
  });

  it('close stops dispatcher and clears listeners', async () => {
    const db = makeDb();
    const c2s = makeC2S(db);
    const listener = vi.fn();

    await c2s.start();
    c2s.onDispatchingChanged(listener);
    c2s.close();

    capturedCdProps.onDispatching(true);

    expect(listener).not.toHaveBeenCalled();
  });

  it('onStart sweep returns states for all collections with records', () => {
    const db = makeDb({
      getAllStatesSync: () => [{ id: 'r1', entries: [] }],
    });
    makeC2S(db);

    const result = capturedCdProps.onStart();

    expect(result).toHaveLength(2);
    expect(result[0].collectionName).toBe('items');
    expect(result[1].collectionName).toBe('orders');
  });

  it('onStart sweep omits empty collections', () => {
    const db = makeDb({ getAllStatesSync: () => [] });
    makeC2S(db);

    const result = capturedCdProps.onStart();

    expect(result).toHaveLength(0);
  });

  it('onUpdate collapses audit for active records', () => {
    const collapseAuditSync = vi.fn();
    const db = makeDb({ collapseAuditSync });
    makeC2S(db);

    capturedCdProps.onUpdate([{
      collectionName: 'items',
      records: [{ record: { id: 'r1' }, lastAuditEntryId: 'e1' }],
      deletedRecordIds: [],
    }]);

    expect(collapseAuditSync).toHaveBeenCalledOnce();
    expect(collapseAuditSync).toHaveBeenCalledWith('r1', 'e1');
  });

  it('onUpdate applies server delete for deleted record ids', () => {
    const collapseAuditSync = vi.fn();
    const applyServerDeleteSync = vi.fn();
    const getStatesSync = vi.fn().mockReturnValue([{ id: 'del1', audit: [{ id: 'e1' }] }]);
    const db = makeDb({ collapseAuditSync, applyServerDeleteSync, getStatesSync });
    makeC2S(db);

    capturedCdProps.onUpdate([{
      collectionName: 'items',
      records: [],
      deletedRecordIds: ['del1'],
    }]);

    expect(applyServerDeleteSync).toHaveBeenCalledOnce();
    expect(applyServerDeleteSync).toHaveBeenCalledWith(['del1']);
  });

  it('onUpdate warns and skips unknown collection', () => {
    const throwingDb = { use: (_name: string) => { throw new Error('unknown collection'); } };
    const c2s = makeC2S(throwingDb);

    // Should not throw even if the logger.warn is called internally
    expect(() => capturedCdProps.onUpdate([{
      collectionName: 'unknown',
      records: [],
      deletedRecordIds: [],
    }])).not.toThrow();

    // Verify stop still works (c2s is usable after the skip)
    expect(() => c2s.stop()).not.toThrow();
  });
});
