import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeTime } from 'ulidx';
import { AuditEntryType, OperationType } from '../../common';
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

vi.mock('../../common/sync-engine', async importOriginal => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    ServerReceiver: class {
      constructor(_logger: unknown, _opts: unknown) {}
      process = mockProcess;
    },
  };
});

import { withRecordLocks, handleClientToServerSync, buildServerRecordStates } from './clientToServerSyncAction';

describe('buildServerRecordStates', () => {
  it('reports a live record that has NO server audit as active with an empty audit (disableAudit)', () => {
    // Regression: disableAudit collections have no audit, so an audit-driven build returned no state at
    // all for a live record. The SR then treated the client's synced-back copy as a deleted "ghost" and
    // pushed a delete, permanently removing the record from that client (delete-is-final).
    const result = buildServerRecordStates([], [{ id: 'r1', name: 'Home' } as any]);
    expect(result).toEqual([{ record: { id: 'r1', name: 'Home' }, audit: [] }]);
  });

  it('attaches the live record to an existing active audit', () => {
    const audit = { id: 'a1', entries: [{ type: AuditEntryType.Created, id: 'e1', record: { id: 'a1', name: 'x' } }] } as any;
    const result = buildServerRecordStates([audit], [{ id: 'a1', name: 'x' } as any]);
    expect(result).toEqual([{ record: { id: 'a1', name: 'x' }, audit: audit.entries }]);
  });

  describe('a live record changed without mxdb (sc-5449)', () => {
    const CREATED_ID = '01JX0000000000000000000000';
    const EDITED_ID = '01JX0000010000000000000000';
    const history = [
      { type: AuditEntryType.Created, id: CREATED_ID, record: { id: 'f1', status: 'booked', notes: '' }, userId: 'office' },
      { type: AuditEntryType.Updated, id: EDITED_ID, ops: [{ type: OperationType.Replace, path: 'notes', value: 'gate code 1234' }], userId: 'office' },
    ];

    it('adds the change its history is missing, as made outside the app, dated right after the history', () => {
      const [state] = buildServerRecordStates([{ id: 'f1', entries: history } as any], [{ id: 'f1', status: 'cancelled', notes: 'gate code 1234' } as any]);
      const entries = (state as { audit: { id: string }[] }).audit;
      expect(entries.slice(0, 2)).toEqual(history);
      expect(entries[2]).toEqual({
        type: AuditEntryType.Updated,
        id: expect.any(String),
        ops: [{ type: OperationType.Replace, path: 'status', value: 'cancelled' }],
        userId: '__mxdb_direct_write__',
      });
      expect(decodeTime(entries[2]!.id)).toBe(decodeTime(EDITED_ID) + 1);
    });

    it('adds nothing when the history already ends in the live record', () => {
      const [state] = buildServerRecordStates([{ id: 'f1', entries: history } as any], [{ id: 'f1', status: 'booked', notes: 'gate code 1234' } as any]);
      expect((state as { audit: unknown[] }).audit).toEqual(history);
    });

    it('adds nothing to a deleted history, nor to a live record with no history', () => {
      const deleted = [...history, { type: AuditEntryType.Deleted, id: '01JX0000020000000000000000', userId: 'office' }];
      const result = buildServerRecordStates([{ id: 'f1', entries: deleted } as any], [{ id: 'f1', status: 'cancelled' } as any, { id: 'f2', status: 'cancelled' } as any]);
      expect(result).toEqual([{ recordId: 'f1', audit: deleted }, { record: { id: 'f2', status: 'cancelled' }, audit: [] }]);
    });
  });

  it('reports a deleted audit as a deleted state', () => {
    const audit = { id: 'd1', entries: [{ type: AuditEntryType.Created, id: 'e1', record: { id: 'd1' } }, { type: AuditEntryType.Deleted, id: 'e2' }] } as any;
    const result = buildServerRecordStates([audit], []);
    expect(result).toEqual([{ recordId: 'd1', audit: audit.entries }]);
  });

  it('skips null audit entries and does not duplicate an audited live record', () => {
    const audit = { id: 'a1', entries: [{ type: AuditEntryType.Created, id: 'e1', record: { id: 'a1', name: 'x' } }] } as any;
    const result = buildServerRecordStates([undefined as any, audit], [{ id: 'a1', name: 'x' } as any]);
    expect(result).toEqual([{ record: { id: 'a1', name: 'x' }, audit: audit.entries }]);
  });
});

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
