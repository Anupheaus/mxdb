import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@anupheaus/common'; // ensure Object.clone and other extensions are installed
import { AuthenticationError } from '@anupheaus/common';
import type { Logger } from '@anupheaus/common';
import { auditor } from '../auditor';

vi.mock('../auditor/hash', () => ({
  hashRecord: (record: any) => Promise.resolve(`mock-hash-${record.id}`),
  deterministicJson: (v: any) => JSON.stringify(v),
  contentHash: (v: any) => `content-${JSON.stringify(v)}`,
}));
import {
  ClientDispatcher,
  ClientReceiver,
  type MXDBSyncEngineResponse,
  type MXDBUpdateRequest,
} from '.';

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  silly: vi.fn(),
} as unknown as Logger;

function makeRecord(id: string, name: string) {
  return { id, name };
}

describe('ClientDispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function makeCR() {
    const onRetrieve = vi.fn().mockReturnValue([]);
    const onUpdate = vi.fn().mockReturnValue([]);
    return new ClientReceiver(mockLogger, { onRetrieve, onUpdate });
  }

  it('enqueue is no-op when stopped', () => {
    const cr = makeCR();
    const onDispatch = vi.fn().mockResolvedValue([]);
    const cd = new ClientDispatcher(mockLogger, {
      clientReceiver: cr,
      onPayloadRequest: vi.fn().mockReturnValue([]),
      onDispatching: vi.fn(),
      onDispatch,
      onUpdate: vi.fn(),
      onStart: vi.fn().mockReturnValue([]),
      timerInterval: 100,
    });

    cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    // Not started, so no dispatch
    vi.runAllTimers();
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it('start triggers onStart dispatch', async () => {
    const cr = makeCR();
    const record = makeRecord('r1', 'Alice');
    const audit = auditor.createAuditFrom(record);

    const onStart = vi.fn().mockReturnValue([{
      collectionName: 'items',
      records: [{ record, audit: audit.entries }],
    }]);

    const onDispatch = vi.fn().mockResolvedValue([{
      collectionName: 'items',
      successfulRecordIds: ['r1'],
    }]);

    const onUpdate = vi.fn();

    const cd = new ClientDispatcher(mockLogger, {
      clientReceiver: cr,
      onPayloadRequest: vi.fn().mockReturnValue([]),
      onDispatching: vi.fn(),
      onDispatch,
      onUpdate,
      onStart,
      timerInterval: 100,
    });

    cd.start();
    await vi.runAllTimersAsync();

    expect(onStart).toHaveBeenCalledOnce();
    expect(onDispatch).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('stop invalidates in-flight response (epoch mismatch)', async () => {
    const cr = makeCR();
    let resolveDispatch: (v: MXDBSyncEngineResponse) => void;

    const onDispatch = vi.fn().mockImplementation(() =>
      new Promise<MXDBSyncEngineResponse>(resolve => { resolveDispatch = resolve; }),
    );

    const onUpdate = vi.fn();
    const onStart = vi.fn().mockReturnValue([]);

    const cd = new ClientDispatcher(mockLogger, {
      clientReceiver: cr,
      onPayloadRequest: vi.fn().mockReturnValue([]),
      onDispatching: vi.fn(),
      onDispatch,
      onUpdate,
      onStart,
      timerInterval: 100,
    });

    cd.start();
    await vi.runAllTimersAsync();

    // stop() before dispatch resolves
    cd.stop();

    // Now resolve the dispatch
    resolveDispatch!([{ collectionName: 'items', successfulRecordIds: ['r1'] }]);
    await vi.runAllTimersAsync();

    // onUpdate should NOT have been called due to epoch mismatch
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('timer fires after enqueue', async () => {
    const cr = makeCR();
    const record = makeRecord('r1', 'Alice');
    const audit = auditor.createAuditFrom(record);

    const onPayloadRequest = vi.fn().mockReturnValue([{
      collectionName: 'items',
      records: [{ record, audit: audit.entries }],
    }]);

    const onDispatch = vi.fn().mockResolvedValue([{
      collectionName: 'items',
      successfulRecordIds: ['r1'],
    }]);

    const onUpdate = vi.fn();

    // onStart returns empty to skip initial dispatch quickly
    const onStart = vi.fn().mockReturnValue([{
      collectionName: 'items',
      records: [{ record, audit: audit.entries }],
    }]);

    const cd = new ClientDispatcher(mockLogger, {
      clientReceiver: cr,
      onPayloadRequest,
      onDispatching: vi.fn(),
      onDispatch,
      onUpdate,
      onStart,
      timerInterval: 50,
    });

    cd.start();
    await vi.runAllTimersAsync(); // process initial onStart

    // Now enqueue something
    cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    await vi.runAllTimersAsync(); // timer fires

    expect(onPayloadRequest).toHaveBeenCalled();
  });

  it('onUpdate is called on success with correct data', async () => {
    const cr = makeCR();
    const record = makeRecord('r1', 'Alice');
    const audit = auditor.createAuditFrom(record);

    const onStart = vi.fn().mockReturnValue([{
      collectionName: 'items',
      records: [{ record, audit: audit.entries }],
    }]);

    const onDispatch = vi.fn().mockResolvedValue([{
      collectionName: 'items',
      successfulRecordIds: ['r1'],
    }]);

    const onUpdate = vi.fn();

    const cd = new ClientDispatcher(mockLogger, {
      clientReceiver: cr,
      onPayloadRequest: vi.fn().mockReturnValue([]),
      onDispatching: vi.fn(),
      onDispatch,
      onUpdate,
      onStart,
      timerInterval: 100,
    });

    cd.start();
    await vi.runAllTimersAsync();

    expect(onUpdate).toHaveBeenCalledOnce();
    const updateArg = onUpdate.mock.calls[0]![0] as MXDBUpdateRequest;
    expect(updateArg[0]!.collectionName).toBe('items');
    expect(updateArg[0]!.records?.[0]!.record).toEqual(record);
    expect(updateArg[0]!.records?.[0]!.lastAuditEntryId).toBeDefined();
  });

  it('duplicate enqueue is no-op', async () => {
    const cr = makeCR();
    const record1 = makeRecord('r1', 'Alice');
    const record2 = makeRecord('r2', 'Bob');
    const audit1 = auditor.createAuditFrom(record1);
    const audit2 = auditor.createAuditFrom(record2);

    const onPayloadRequest = vi.fn().mockImplementation((_req: any) => {
      // Return states for both requested records
      return [{
        collectionName: 'items',
        records: [
          { record: record1, audit: audit1.entries },
          { record: record2, audit: audit2.entries },
        ],
      }];
    });

    const onDispatch = vi.fn().mockResolvedValue([{
      collectionName: 'items',
      successfulRecordIds: ['r1', 'r2'],
    }]);
    const onStart = vi.fn().mockReturnValue([]);

    const cd = new ClientDispatcher(mockLogger, {
      clientReceiver: cr,
      onPayloadRequest,
      onDispatching: vi.fn(),
      onDispatch,
      onUpdate: vi.fn(),
      onStart,
      timerInterval: 100,
    });

    cd.start();
    await vi.runAllTimersAsync(); // process onStart

    vi.clearAllMocks();
    cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    cd.enqueue({ collectionName: 'items', recordId: 'r1' }); // duplicate
    cd.enqueue({ collectionName: 'items', recordId: 'r2' }); // different record

    // The queue should only have 2 items (r1 deduplicated)
    await vi.runAllTimersAsync();
    expect(onPayloadRequest).toHaveBeenCalledOnce();
    const requestArg = onPayloadRequest.mock.calls[0][0];
    expect(requestArg[0].recordIds).toHaveLength(2);
    expect(requestArg[0].recordIds).toContain('r1');
    expect(requestArg[0].recordIds).toContain('r2');
  });

  it('start is idempotent', async () => {
    const cr = makeCR();
    const onStart = vi.fn().mockReturnValue([]);
    const onDispatch = vi.fn().mockResolvedValue([]);

    const cd = new ClientDispatcher(mockLogger, {
      clientReceiver: cr,
      onPayloadRequest: vi.fn().mockReturnValue([]),
      onDispatching: vi.fn(),
      onDispatch,
      onUpdate: vi.fn(),
      onStart,
      timerInterval: 100,
    });

    cd.start();
    cd.start(); // should be no-op
    await vi.runAllTimersAsync();

    expect(onStart).toHaveBeenCalledOnce();
  });

  it('re-enqueues a record whose enqueue arrived while it was in-flight', async () => {
    // Regression: if enqueue(X) is called while X is already being dispatched,
    // the original enqueue() used to no-op (because X was already in the queue),
    // and #processSuccessResponse then removed X — silently losing the update.
    // #pendingReEnqueue must capture this case and re-queue X after success.
    const cr = makeCR();
    const record = makeRecord('r1', 'Alice');
    const audit = auditor.createAuditFrom(record);

    let resolveDispatch: (v: MXDBSyncEngineResponse) => void;
    const onDispatch = vi.fn().mockImplementation(() =>
      new Promise<MXDBSyncEngineResponse>(resolve => { resolveDispatch = resolve; }),
    );

    const onPayloadRequest = vi.fn().mockReturnValue([{
      collectionName: 'items',
      records: [{ record, audit: audit.entries }],
    }]);

    const cd = new ClientDispatcher(mockLogger, {
      clientReceiver: cr,
      onPayloadRequest,
      onDispatching: vi.fn(),
      onDispatch,
      onUpdate: vi.fn(),
      onStart: vi.fn().mockReturnValue([]),
      timerInterval: 50,
    });

    cd.start();
    await vi.runAllTimersAsync(); // initial onStart completes (empty)

    // First enqueue — kicks off a timer tick + dispatch that we keep pending
    cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    await vi.advanceTimersByTimeAsync(50); // fire the timer
    // dispatch is now in-flight (waiting on resolveDispatch)

    // While in-flight, enqueue r1 again — this is the racing update
    cd.enqueue({ collectionName: 'items', recordId: 'r1' });

    // Resolve the in-flight dispatch successfully
    resolveDispatch!([{ collectionName: 'items', successfulRecordIds: ['r1'] }]);
    await vi.runAllTimersAsync();

    // The timer should have been restarted to pick up the re-enqueued record,
    // and a second dispatch should have fired for r1.
    expect(onDispatch).toHaveBeenCalledTimes(2);
  });

  it('drops queue entries whose state has disappeared before dispatch', async () => {
    // Regression: if a record is deleted locally (e.g. by an incoming S2C push)
    // while it sits in the CD queue, onPayloadRequest will not return a state
    // for it. Without the drop-filter, the stale queue entry would live forever.
    const cr = makeCR();
    const record2 = makeRecord('r2', 'Bob');
    const audit2 = auditor.createAuditFrom(record2);

    // onPayloadRequest returns ONLY r2 — r1 has disappeared locally
    const onPayloadRequest = vi.fn().mockReturnValue([{
      collectionName: 'items',
      records: [{ record: record2, audit: audit2.entries }],
    }]);

    const onDispatch = vi.fn().mockResolvedValue([{
      collectionName: 'items',
      successfulRecordIds: ['r2'],
    }]);

    const cd = new ClientDispatcher(mockLogger, {
      clientReceiver: cr,
      onPayloadRequest,
      onDispatching: vi.fn(),
      onDispatch,
      onUpdate: vi.fn(),
      onStart: vi.fn().mockReturnValue([]),
      timerInterval: 50,
    });

    cd.start();
    await vi.runAllTimersAsync(); // onStart completes (dispatches empty)

    onDispatch.mockClear();
    cd.enqueue({ collectionName: 'items', recordId: 'r1' });
    cd.enqueue({ collectionName: 'items', recordId: 'r2' });
    await vi.runAllTimersAsync();

    // dispatch called with only r2 (r1 disappeared → filtered out)
    expect(onDispatch).toHaveBeenCalled();
    const dispatchArg = onDispatch.mock.calls[0][0];
    const ids = dispatchArg[0].records.map((r: any) => r.id);
    expect(ids).toEqual(['r2']);

    // After completion, no second dispatch should be scheduled for orphan r1
    vi.clearAllMocks();
    await vi.runAllTimersAsync();
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it('uses the last audit entry (insertion order) for lastAuditEntryId, not the max ULID', async () => {
    // Regression: getLastEntryId previously picked the entry with the largest
    // ULID. After collapseToAnchor, the audit may look like:
    //   [Branched(server-ulid-NEW), Updated(client-ulid-OLD)]
    // where the Branched anchor's id is lexicographically greater than the
    // client-generated Updated id. Picking the max would return the anchor,
    // leaving pending Updated entries after the collapse point — the audit
    // would never become branch-only again. Fix: use insertion order.
    const cr = makeCR();
    const record = makeRecord('r1', 'Alice');

    // Hand-crafted audit: a Branched entry with a high ULID followed by an
    // Updated entry with a lower ULID (out-of-order vs. ULID sort).
    const audit = [
      { id: 'zzz-high-branched-anchor', type: 3 /* Branched */, at: 1, by: 'srv', changes: {} },
      { id: 'aaa-low-client-update', type: 2 /* Updated */, at: 2, by: 'cli', changes: { name: { from: 'Alice', to: 'Bob' } } },
    ] as any;

    const onStart = vi.fn().mockReturnValue([{
      collectionName: 'items',
      records: [{ record, audit }],
    }]);

    const onDispatch = vi.fn().mockResolvedValue([{
      collectionName: 'items',
      successfulRecordIds: ['r1'],
    }]);

    const onUpdate = vi.fn();

    const cd = new ClientDispatcher(mockLogger, {
      clientReceiver: cr,
      onPayloadRequest: vi.fn().mockReturnValue([]),
      onDispatching: vi.fn(),
      onDispatch,
      onUpdate,
      onStart,
      timerInterval: 100,
    });

    cd.start();
    await vi.runAllTimersAsync();

    expect(onUpdate).toHaveBeenCalledOnce();
    const updateArg = onUpdate.mock.calls[0]![0] as MXDBUpdateRequest;
    // Must be the insertion-order last entry ('aaa-low-client-update'), NOT
    // the max-ULID entry ('zzz-high-branched-anchor').
    expect(updateArg[0]!.records?.[0]!.lastAuditEntryId).toBe('aaa-low-client-update');
  });

  describe('communication error retry', () => {
    it('retries onStart dispatch after a communication error (e.g. socket disconnected)', async () => {
      const cr = makeCR();
      const record = makeRecord('r1', 'Alice');
      const audit = auditor.createAuditFrom(record);

      const onStart = vi.fn().mockReturnValue([{
        collectionName: 'items',
        records: [{ record, audit: audit.entries }],
      }]);

      // First call rejects (simulating socket disconnection), second succeeds
      const onDispatch = vi.fn()
        .mockRejectedValueOnce(new Error('socket has been disconnected'))
        .mockResolvedValueOnce([{
          collectionName: 'items',
          successfulRecordIds: ['r1'],
        }]);

      const onUpdate = vi.fn();

      const cd = new ClientDispatcher(mockLogger, {
        clientReceiver: cr,
        onPayloadRequest: vi.fn().mockReturnValue([]),
        onDispatching: vi.fn(),
        onDispatch,
        onUpdate,
        onStart,
        timerInterval: 50,
      });

      cd.start();
      // First attempt fires and fails
      await vi.advanceTimersByTimeAsync(0);
      expect(onDispatch).toHaveBeenCalledOnce();
      expect(onUpdate).not.toHaveBeenCalled();

      // Retry fires after timerInterval
      await vi.advanceTimersByTimeAsync(50);
      expect(onDispatch).toHaveBeenCalledTimes(2);
      expect(onUpdate).toHaveBeenCalledOnce();

      cd.stop();
    });

    it('retries timer-based dispatch after a communication error', async () => {
      const cr = makeCR();
      const record = makeRecord('r1', 'Alice');
      const audit = auditor.createAuditFrom(record);

      const onPayloadRequest = vi.fn().mockReturnValue([{
        collectionName: 'items',
        records: [{ record, audit: audit.entries }],
      }]);

      // onStart succeeds (empty), then timer dispatch fails once, then succeeds
      const onDispatch = vi.fn()
        .mockResolvedValueOnce([]) // onStart — no records
        .mockRejectedValueOnce(new Error('transport close'))
        .mockResolvedValueOnce([{
          collectionName: 'items',
          successfulRecordIds: ['r1'],
        }]);

      const onUpdate = vi.fn();

      const cd = new ClientDispatcher(mockLogger, {
        clientReceiver: cr,
        onPayloadRequest,
        onDispatching: vi.fn(),
        onDispatch,
        onUpdate,
        onStart: vi.fn().mockReturnValue([]),
        timerInterval: 50,
      });

      cd.start();
      await vi.runAllTimersAsync(); // onStart completes

      // Enqueue a record — will fire a timer tick
      cd.enqueue({ collectionName: 'items', recordId: 'r1' });

      // First timer tick — dispatch fails
      await vi.advanceTimersByTimeAsync(50);
      expect(onDispatch).toHaveBeenCalledTimes(2); // onStart + failed tick
      expect(onUpdate).not.toHaveBeenCalled();

      // Retry timer tick — dispatch succeeds
      await vi.advanceTimersByTimeAsync(50);
      expect(onDispatch).toHaveBeenCalledTimes(3);
      expect(onUpdate).toHaveBeenCalledOnce();

      cd.stop();
    });

    it('retries multiple times until dispatch succeeds', async () => {
      const cr = makeCR();
      const record = makeRecord('r1', 'Alice');
      const audit = auditor.createAuditFrom(record);

      const onStart = vi.fn().mockReturnValue([{
        collectionName: 'items',
        records: [{ record, audit: audit.entries }],
      }]);

      // Fail 3 times, then succeed
      const onDispatch = vi.fn()
        .mockRejectedValueOnce(new Error('socket has been disconnected'))
        .mockRejectedValueOnce(new Error('transport close'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce([{
          collectionName: 'items',
          successfulRecordIds: ['r1'],
        }]);

      const onUpdate = vi.fn();

      const cd = new ClientDispatcher(mockLogger, {
        clientReceiver: cr,
        onPayloadRequest: vi.fn().mockReturnValue([]),
        onDispatching: vi.fn(),
        onDispatch,
        onUpdate,
        onStart,
        timerInterval: 50,
      });

      cd.start();

      // Attempt 1 fails
      await vi.advanceTimersByTimeAsync(0);
      expect(onDispatch).toHaveBeenCalledTimes(1);

      // Attempt 2 fails
      await vi.advanceTimersByTimeAsync(50);
      expect(onDispatch).toHaveBeenCalledTimes(2);

      // Attempt 3 fails
      await vi.advanceTimersByTimeAsync(50);
      expect(onDispatch).toHaveBeenCalledTimes(3);

      // Attempt 4 succeeds
      await vi.advanceTimersByTimeAsync(50);
      expect(onDispatch).toHaveBeenCalledTimes(4);
      expect(onUpdate).toHaveBeenCalledOnce();

      cd.stop();
    });

    it('does not retry after stop() is called during a failed dispatch', async () => {
      const cr = makeCR();
      const record = makeRecord('r1', 'Alice');
      const audit = auditor.createAuditFrom(record);

      let rejectDispatch: (err: Error) => void;
      const onDispatch = vi.fn().mockImplementation(() =>
        new Promise<MXDBSyncEngineResponse>((_resolve, reject) => { rejectDispatch = reject; }),
      );

      const onStart = vi.fn().mockReturnValue([{
        collectionName: 'items',
        records: [{ record, audit: audit.entries }],
      }]);

      const cd = new ClientDispatcher(mockLogger, {
        clientReceiver: cr,
        onPayloadRequest: vi.fn().mockReturnValue([]),
        onDispatching: vi.fn(),
        onDispatch,
        onUpdate: vi.fn(),
        onStart,
        timerInterval: 50,
      });

      cd.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(onDispatch).toHaveBeenCalledOnce();

      // Stop while dispatch is in-flight, then let it fail
      cd.stop();
      rejectDispatch!(new Error('socket has been disconnected'));
      await vi.runAllTimersAsync();

      // No retry — stop() killed the epoch
      expect(onDispatch).toHaveBeenCalledOnce();
    });

    it('catches errors thrown by onDispatch without surfacing unhandled rejections', async () => {
      const cr = makeCR();
      const record = makeRecord('r1', 'Alice');
      const audit = auditor.createAuditFrom(record);

      const onStart = vi.fn().mockReturnValue([{
        collectionName: 'items',
        records: [{ record, audit: audit.entries }],
      }]);

      // Reject with a non-standard error shape (e.g. socket.io internal error)
      const onDispatch = vi.fn()
        .mockRejectedValueOnce({ message: 'socket has been disconnected', name: 'Error' })
        .mockResolvedValueOnce([{
          collectionName: 'items',
          successfulRecordIds: ['r1'],
        }]);

      const cd = new ClientDispatcher(mockLogger, {
        clientReceiver: cr,
        onPayloadRequest: vi.fn().mockReturnValue([]),
        onDispatching: vi.fn(),
        onDispatch,
        onUpdate: vi.fn(),
        onStart,
        timerInterval: 50,
      });

      // Should not throw — errors are caught and logged
      cd.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);

      expect(onDispatch).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalled();

      cd.stop();
    });

    it('stop() → start() while old #doStart dispatch is in-flight does not clobber new coroutine state', async () => {
      // Race: old #doStart is awaiting onDispatch. stop() → start() launches a
      // new #doStart. When the old onDispatch resolves, its finally block must
      // NOT reset #inFlight or call resume() — those belong to the new coroutine.
      const cr = makeCR();
      const record = makeRecord('r1', 'Alice');
      const audit = auditor.createAuditFrom(record);

      let resolveOldDispatch: (v: MXDBSyncEngineResponse) => void;
      let dispatchCallCount = 0;
      const onDispatch = vi.fn().mockImplementation(() => {
        dispatchCallCount++;
        if (dispatchCallCount === 1) {
          // First dispatch (old coroutine) — hold it pending
          return new Promise<MXDBSyncEngineResponse>(resolve => { resolveOldDispatch = resolve; });
        }
        // Second dispatch (new coroutine) — also hold pending so we can inspect state
        return new Promise<MXDBSyncEngineResponse>(() => { /* never resolves during test */ });
      });

      const onDispatching = vi.fn();
      const onStart = vi.fn().mockReturnValue([{
        collectionName: 'items',
        records: [{ record, audit: audit.entries }],
      }]);

      const cd = new ClientDispatcher(mockLogger, {
        clientReceiver: cr,
        onPayloadRequest: vi.fn().mockReturnValue([]),
        onDispatching,
        onDispatch,
        onUpdate: vi.fn(),
        onStart,
        timerInterval: 50,
      });

      // Start first coroutine — it calls onDispatch and blocks
      cd.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(onDispatch).toHaveBeenCalledOnce();
      expect(onDispatching).toHaveBeenLastCalledWith(true);

      // stop() → start() while old dispatch is pending
      cd.stop();
      // stop() should have called onDispatching(false) since it was in-flight
      expect(onDispatching).toHaveBeenCalledWith(false);

      onDispatching.mockClear();
      cd.start();
      await vi.advanceTimersByTimeAsync(0);
      // New coroutine should have called onDispatching(true)
      expect(onDispatching).toHaveBeenCalledWith(true);

      // Now resolve the OLD dispatch — its finally block must NOT call onDispatching(false)
      onDispatching.mockClear();
      resolveOldDispatch!([{ collectionName: 'items', successfulRecordIds: ['r1'] }]);
      await vi.advanceTimersByTimeAsync(0);

      // onDispatching should NOT have been called by the old coroutine
      expect(onDispatching).not.toHaveBeenCalled();

      cd.stop();
    });

    it('re-gathers payload state on retry (not stale snapshot)', async () => {
      const cr = makeCR();
      const recordV1 = makeRecord('r1', 'Alice');
      const recordV2 = makeRecord('r1', 'AliceUpdated');
      const auditV1 = auditor.createAuditFrom(recordV1);
      const auditV2 = auditor.createAuditFrom(recordV2);

      // onStart returns v1 first time, v2 second time (simulating local edit during retry delay)
      const onStart = vi.fn()
        .mockReturnValueOnce([{
          collectionName: 'items',
          records: [{ record: recordV1, audit: auditV1.entries }],
        }])
        .mockReturnValueOnce([{
          collectionName: 'items',
          records: [{ record: recordV2, audit: auditV2.entries }],
        }]);

      const dispatched: any[] = [];
      const onDispatch = vi.fn()
        .mockImplementationOnce(async (req: any) => {
          dispatched.push(JSON.parse(JSON.stringify(req)));
          throw new Error('socket has been disconnected');
        })
        .mockImplementationOnce(async (req: any) => {
          dispatched.push(JSON.parse(JSON.stringify(req)));
          return [{ collectionName: 'items', successfulRecordIds: ['r1'] }];
        });

      const cd = new ClientDispatcher(mockLogger, {
        clientReceiver: cr,
        onPayloadRequest: vi.fn().mockReturnValue([]),
        onDispatching: vi.fn(),
        onDispatch,
        onUpdate: vi.fn(),
        onStart,
        timerInterval: 50,
      });

      cd.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);

      expect(onStart).toHaveBeenCalledTimes(2);
      // The retry re-called onStart() to get fresh state
      expect(dispatched).toHaveLength(2);

      cd.stop();
    });

    it('stops retrying onStart dispatch on Unauthorized and allows restart via start()', async () => {
      const cr = makeCR();
      const record = makeRecord('r1', 'Alice');
      const audit = auditor.createAuditFrom(record);

      const onStart = vi.fn().mockReturnValue([{
        collectionName: 'items',
        records: [{ record, audit: audit.entries }],
      }]);

      const onDispatch = vi.fn().mockRejectedValue(new AuthenticationError('Unauthorized'));

      const cd = new ClientDispatcher(mockLogger, {
        clientReceiver: cr,
        onPayloadRequest: vi.fn().mockReturnValue([]),
        onDispatching: vi.fn(),
        onDispatch,
        onUpdate: vi.fn(),
        onStart,
        timerInterval: 50,
      });

      cd.start();
      await vi.advanceTimersByTimeAsync(0);
      // Unauthorized fired — dispatcher should have stopped itself
      expect(onDispatch).toHaveBeenCalledOnce();

      // Advance well past the retry interval to confirm no retry occurs
      await vi.advanceTimersByTimeAsync(500);
      expect(onDispatch).toHaveBeenCalledOnce();

      // After stop() (called internally), start() can be called again (simulating reconnect)
      // First call to onStart() returns records, onDispatch now resolves
      onDispatch.mockResolvedValueOnce([{ collectionName: 'items', successfulRecordIds: ['r1'] }]);
      cd.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(onDispatch).toHaveBeenCalledTimes(2);

      cd.stop();
    });

    it('stops retrying timer dispatch on Unauthorized', async () => {
      const cr = makeCR();
      const record = makeRecord('r1', 'Alice');
      const audit = auditor.createAuditFrom(record);

      const onPayloadRequest = vi.fn().mockReturnValue([{
        collectionName: 'items',
        records: [{ record, audit: audit.entries }],
      }]);

      // onStart succeeds (empty), then timer dispatch throws Unauthorized
      const onDispatch = vi.fn()
        .mockResolvedValueOnce([]) // onStart — no records, starts timer via enqueue below
        .mockRejectedValue(new AuthenticationError('Unauthorized'));

      const cd = new ClientDispatcher(mockLogger, {
        clientReceiver: cr,
        onPayloadRequest,
        onDispatching: vi.fn(),
        onDispatch,
        onUpdate: vi.fn(),
        onStart: vi.fn().mockReturnValue([]),
        timerInterval: 50,
      });

      cd.start();
      await vi.advanceTimersByTimeAsync(0); // onStart dispatch succeeds (empty)
      expect(onDispatch).toHaveBeenCalledOnce();

      // Enqueue a record to trigger a timer dispatch
      cd.enqueue({ collectionName: 'items', recordId: 'r1' });
      await vi.advanceTimersByTimeAsync(50);
      expect(onDispatch).toHaveBeenCalledTimes(2); // timer dispatch fires once — Unauthorized

      // Advance past retry interval: should NOT retry
      await vi.advanceTimersByTimeAsync(500);
      expect(onDispatch).toHaveBeenCalledTimes(2);

      cd.stop();
    });
  });

  it('onDispatching is called true/false around dispatch', async () => {
    const cr = makeCR();
    const onDispatching = vi.fn();
    const record = makeRecord('r1', 'Alice');
    const audit = auditor.createAuditFrom(record);

    const onStart = vi.fn().mockReturnValue([{
      collectionName: 'items',
      records: [{ record, audit: audit.entries }],
    }]);
    const onDispatch = vi.fn().mockResolvedValue([{
      collectionName: 'items',
      successfulRecordIds: ['r1'],
    }]);

    const cd = new ClientDispatcher(mockLogger, {
      clientReceiver: cr,
      onPayloadRequest: vi.fn().mockReturnValue([]),
      onDispatching,
      onDispatch,
      onUpdate: vi.fn(),
      onStart,
      timerInterval: 100,
    });

    cd.start();
    await vi.runAllTimersAsync();

    expect(onDispatching).toHaveBeenCalledWith(true);
    expect(onDispatching).toHaveBeenCalledWith(false);
  });
});
