import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditEntryType } from '../../common';
import type { ClientDispatcherRequest } from '../../common/sync-engine';

const mockProcess = vi.fn();

const mockUseDb = vi.fn();
const mockUseServerToClientSynchronisation = vi.fn();
const mockUseLogger = vi.fn();

vi.mock('../providers', () => ({
  useDb: () => mockUseDb(),
  useServerToClientSynchronisation: () => mockUseServerToClientSynchronisation(),
}));

vi.mock('@anupheaus/nexus/server', () => ({
  createServerActionHandler: (_def: unknown, handler: unknown) => handler,
  useLogger: () => mockUseLogger(),
}));

vi.mock('../../common/sync-engine', async (importOriginal) => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    ServerReceiver: class {
      constructor(_logger: unknown, _opts: unknown) {}
      process = mockProcess;
    },
  };
});

import { withRecordLocks, handleClientToServerSync } from './clientToServerSyncAction';

const mockWarn = vi.fn();
const mockError = vi.fn();
const mockLogger = {
  warn: mockWarn,
  error: mockError,
  info: vi.fn(),
  debug: vi.fn(),
  silly: vi.fn(),
  createSubLogger: vi.fn().mockReturnThis(),
};

describe('withRecordLocks', () => {
  it('executes immediately with no keys', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRecordLocks([], fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toBe(42);
  });

  it('executes in sequence for the same key', async () => {
    const order: number[] = [];

    // Set up the first promise's resolve handle BEFORE calling withRecordLocks
    let resolveFirst!: (value: number) => void;
    const firstInner = new Promise<number>(resolve => { resolveFirst = resolve; });

    const first = withRecordLocks(['key-a'], () => {
      order.push(1);
      return firstInner;
    });

    // Allow the microtask queue to drain so the first fn gets called
    await Promise.resolve();
    await Promise.resolve();

    const second = withRecordLocks(['key-a'], async () => {
      order.push(2);
      return 2;
    });

    // Allow microtasks — second should not have run yet
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1]);

    resolveFirst(1);
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(order).toEqual([1, 2]);
  });

  it('executes in parallel for different keys', async () => {
    const started: number[] = [];
    let resolveA!: (v: number) => void;
    let resolveB!: (v: number) => void;

    const a = withRecordLocks(['key-a'], () => new Promise<number>(resolve => {
      started.push(1);
      resolveA = resolve;
    }));

    const b = withRecordLocks(['key-b'], () => new Promise<number>(resolve => {
      started.push(2);
      resolveB = resolve;
    }));

    // Drain the microtask queue so both fns have been invoked
    await Promise.resolve();
    await Promise.resolve();

    // Both functions should have been called (started) before either resolved
    expect(started).toContain(1);
    expect(started).toContain(2);

    resolveA(1);
    resolveB(2);
    await Promise.all([a, b]);
  });
});

describe('handleClientToServerSync', () => {
  const baseRequest: ClientDispatcherRequest = [
    {
      collectionName: 'items',
      records: [
        {
          id: 'r1',
          entries: [{ type: AuditEntryType.Created, id: 'entry-1', record: { id: 'r1' } } as never],
        },
      ],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLogger.mockReturnValue(mockLogger);
    mockUseDb.mockReturnValue({ use: vi.fn() });
    mockUseServerToClientSynchronisation.mockReturnValue({
      isNoOp: false,
      dispatcher: {},
    });
  });

  it('returns empty response when s2c isNoOp', async () => {
    mockUseServerToClientSynchronisation.mockReturnValue({
      isNoOp: true,
      dispatcher: {},
    });

    const result = await handleClientToServerSync(baseRequest);
    expect(result).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith('C2S sync handler invoked under no-op S2C instance — skipping');
  });

  it('delegates to ServerReceiver.process and returns its result', async () => {
    const expected = [{ collectionName: 'items', successfulRecordIds: ['r1'] }];
    mockProcess.mockResolvedValue(expected);

    const result = await handleClientToServerSync(baseRequest);
    expect(result).toEqual(expected);
    expect(mockProcess).toHaveBeenCalledTimes(1);
  });

  it('only locks records with non-Branched entries', async () => {
    const mixedRequest: ClientDispatcherRequest = [
      {
        collectionName: 'items',
        records: [
          // Branched-only — should NOT be locked
          {
            id: 'r-branched',
            entries: [{ type: AuditEntryType.Branched, id: 'b-1' } as never],
          },
          // Created entry — SHOULD be locked
          {
            id: 'r-created',
            entries: [{ type: AuditEntryType.Created, id: 'c-1', record: { id: 'r-created' } } as never],
          },
        ],
      },
    ];

    const expected = [{ collectionName: 'items', successfulRecordIds: ['r-created'] }];
    mockProcess.mockResolvedValue(expected);

    // Should not throw and should call process once
    const result = await handleClientToServerSync(mixedRequest);
    expect(mockProcess).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expected);
  });

  it('throws non-transient errors', async () => {
    const permanentError = new Error('permanent failure');
    mockProcess.mockRejectedValue(permanentError);

    await expect(handleClientToServerSync(baseRequest)).rejects.toThrow('permanent failure');
    expect(mockError).toHaveBeenCalledWith('C2S sync process failed', { error: permanentError });
  });
});
