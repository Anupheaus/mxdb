import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@anupheaus/common';
import {
  ServerDispatcher,
  SyncPausedError,
  type MXDBRecordCursors,
  type ServerDispatcherFilter,
} from '.';

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  silly: vi.fn(),
} as unknown as Logger;

function makeActiveCursor(id: string, hash: string, lastAuditEntryId: string) {
  return { record: { id }, lastAuditEntryId, hash } as any;
}

function makeDeletedCursor(recordId: string, lastAuditEntryId: string) {
  return { recordId, lastAuditEntryId };
}

describe('ServerDispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('pause / resume', () => {
    it('pause is idempotent', async () => {
      const onDispatch = vi.fn().mockResolvedValue([]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });
      sd.pause();
      sd.pause(); // no-op
      // Push something — should not dispatch since paused
      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash1', 'u1')] }]);
      await vi.runAllTimersAsync();
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('resume calls dispatch if not in-flight and queue non-empty', async () => {
      const onDispatch = vi.fn().mockResolvedValue([{ collectionName: 'items', successfulRecordIds: ['r1'] }]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });
      sd.pause();
      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash1', 'u1')] }]);
      expect(onDispatch).not.toHaveBeenCalled();
      sd.resume();
      await vi.runAllTimersAsync();
      expect(onDispatch).toHaveBeenCalledOnce();
    });
  });

  describe('push and dispatch', () => {
    it('dispatches immediately when not paused', async () => {
      const onDispatch = vi.fn().mockResolvedValue([{ collectionName: 'items', successfulRecordIds: ['r1'] }]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });

      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash1', 'u1')] }]);
      await vi.runAllTimersAsync();
      expect(onDispatch).toHaveBeenCalledOnce();
    });

    it('skips dispatch when fresh request is empty (all filtered)', async () => {
      // Set up a filter where the record is already up to date
      const onDispatch = vi.fn().mockResolvedValue([]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });

      // Add to filter first
      const filter: ServerDispatcherFilter[] = [{
        collectionName: 'items',
        records: [{ id: 'r1', hash: 'hash1', lastAuditEntryId: 'u1' }],
      }];
      sd.updateFilter(filter);

      // Push same record with same hash+lastAuditEntryId
      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash1', 'u1')] }]);
      await vi.runAllTimersAsync();
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('dispatches when record hash differs from filter', async () => {
      const onDispatch = vi.fn().mockResolvedValue([{ collectionName: 'items', successfulRecordIds: ['r1'] }]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });

      const filter: ServerDispatcherFilter[] = [{
        collectionName: 'items',
        records: [{ id: 'r1', hash: 'old-hash', lastAuditEntryId: 'u1' }],
      }];
      sd.updateFilter(filter);

      // Push with new hash
      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'new-hash', 'u2')] }]);
      await vi.runAllTimersAsync();
      expect(onDispatch).toHaveBeenCalledOnce();
    });
  });

  describe('filter management', () => {
    it('updateFilter merges records — updates or adds, never removes', async () => {
      const onDispatch = vi.fn().mockResolvedValue([{ collectionName: 'items', successfulRecordIds: ['r2'] }]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });

      sd.updateFilter([{
        collectionName: 'items',
        records: [
          { id: 'r1', hash: 'hash1', lastAuditEntryId: 'u1' },
          { id: 'r2', hash: 'hash2', lastAuditEntryId: 'u2' },
        ],
      }]);

      // Update filter — r1 updated, r2 unchanged, r3 new
      sd.updateFilter([{
        collectionName: 'items',
        records: [
          { id: 'r1', hash: 'hash1-new', lastAuditEntryId: 'u3' },
          { id: 'r3', hash: 'hash3', lastAuditEntryId: 'u4' },
        ],
      }]);

      // Push r2 with new hash — should dispatch since it differs
      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r2', 'hash2-new', 'u5')] }]);
      await vi.runAllTimersAsync();
      expect(onDispatch).toHaveBeenCalledOnce();
    });

    it('registers deletedRecordIds into internal set', async () => {
      const onDispatch = vi.fn().mockResolvedValue([]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });

      sd.updateFilter([{
        collectionName: 'items',
        records: [],
        deletedRecordIds: ['deleted-r1', 'deleted-r2'],
      }]);

      // Push an update for deleted record — should be skipped
      sd.push([{ collectionName: 'items', records: [makeActiveCursor('deleted-r1', 'hash1', 'u1')] }]);
      await vi.runAllTimersAsync();
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('delete wins over update in squash', async () => {
      const onDispatch = vi.fn().mockResolvedValue([{ collectionName: 'items', successfulRecordIds: ['r1'] }]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });

      // Add r1 to filter so the SD knows the client has it
      sd.updateFilter([{
        collectionName: 'items',
        records: [{ id: 'r1', hash: 'hash1', lastAuditEntryId: 'u1' }],
      }]);

      // Pause first so both items are in queue before dispatch runs
      sd.pause();
      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash2', 'u2')] }]);
      sd.push([{ collectionName: 'items', records: [makeDeletedCursor('r1', 'u3')] }]);
      sd.resume();

      await vi.runAllTimersAsync();
      expect(onDispatch).toHaveBeenCalledOnce();
      const arg = onDispatch.mock.calls[0]![0] as MXDBRecordCursors;
      const rec = arg[0]?.records[0];
      expect('recordId' in rec!).toBe(true);
      expect((rec as any).recordId).toBe('r1');
    });

    it('successful delete removes from filter and adds to deletedRecordIds', async () => {
      const onDispatch = vi.fn().mockResolvedValue([{ collectionName: 'items', successfulRecordIds: ['r1'] }]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });

      // Add to filter
      sd.updateFilter([{
        collectionName: 'items',
        records: [{ id: 'r1', hash: 'hash1', lastAuditEntryId: 'u1' }],
      }]);

      // Push delete
      sd.push([{ collectionName: 'items', records: [makeDeletedCursor('r1', 'u2')] }]);
      await vi.runAllTimersAsync();
      expect(onDispatch).toHaveBeenCalledOnce();

      // After success, r1 should be in deletedRecordIds — subsequent update should be skipped
      vi.clearAllMocks();
      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash2', 'u3')] }]);
      await vi.runAllTimersAsync();
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('unsuccessful delete marks record as pending deletion (hash absent)', async () => {
      // First call: delete fails. Second call (retry): returns success to stop the loop.
      let callCount = 0;
      const onDispatch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return [{ collectionName: 'items', successfulRecordIds: [] }]; // delete fails
        return [{ collectionName: 'items', successfulRecordIds: ['r1'] }]; // retry succeeds
      });
      const sd = new ServerDispatcher(mockLogger, { onDispatch });

      // Add to filter
      sd.updateFilter([{
        collectionName: 'items',
        records: [{ id: 'r1', hash: 'hash1', lastAuditEntryId: 'u1' }],
      }]);

      // Push delete that initially fails
      sd.push([{ collectionName: 'items', records: [makeDeletedCursor('r1', 'u2')] }]);
      // Run only one tick to get the first dispatch
      await vi.runAllTimersAsync();

      // onDispatch called at least once (the failed delete)
      expect(onDispatch.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('pending deletion filter re-sends delete cursor when update is pushed', async () => {
      // SD with a filter showing r1 as pending deletion (hash absent)
      const onDispatch = vi.fn().mockResolvedValue([{ collectionName: 'items', successfulRecordIds: ['r1'] }]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });
      sd.updateFilter([{
        collectionName: 'items',
        records: [{ id: 'r1', lastAuditEntryId: 'u2' }], // no hash = pending deletion
      }]);
      // Push an update — should be converted to delete cursor
      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash2', 'u3')] }]);
      await vi.runAllTimersAsync();
      expect(onDispatch).toHaveBeenCalledOnce();
      const arg = onDispatch.mock.calls[0]![0] as MXDBRecordCursors;
      const rec = arg[0]?.records[0];
      expect('recordId' in rec!).toBe(true);
    });
  });

  describe('delete-is-final semantics', () => {
    it('successful delete for a record never seen in filter still populates deletedRecordIds', async () => {
      // Regression: previously there was a `wasInFilter` gate that prevented the id
      // from being added to #deletedRecordIds when the record had never been in the
      // filter. That left the SD blind to stale active cursors arriving later via
      // bootstrap / concurrent routes, allowing resurrection races.
      const onDispatch = vi.fn().mockResolvedValue([{ collectionName: 'items', successfulRecordIds: ['r1'] }]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });

      // NOTE: no updateFilter call — r1 has never been in the filter
      sd.push([{ collectionName: 'items', records: [makeDeletedCursor('r1', 'u1')] }]);
      await vi.runAllTimersAsync();
      expect(onDispatch).toHaveBeenCalledOnce();

      // A subsequent active cursor for r1 must be filtered out — delete is final,
      // even though r1 was never in the filter when the delete arrived.
      vi.clearAllMocks();
      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash-new', 'u2')] }]);
      await vi.runAllTimersAsync();
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('sends delete cursors through even when record is unknown to filter', async () => {
      // The CR handles "no local state" deletes as already-consistent, so the SD
      // must not swallow delete cursors just because the record isn't tracked in
      // its filter. Previously a scaffolded "deferred deletes" path dropped these.
      const onDispatch = vi.fn().mockResolvedValue([{ collectionName: 'items', successfulRecordIds: ['unknown-r'] }]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });

      // Empty filter — unknown-r has never been seen
      sd.push([{ collectionName: 'items', records: [makeDeletedCursor('unknown-r', 'u1')] }]);
      await vi.runAllTimersAsync();

      expect(onDispatch).toHaveBeenCalledOnce();
      const arg = onDispatch.mock.calls[0]![0] as MXDBRecordCursors;
      expect(arg[0]!.records).toHaveLength(1);
      expect((arg[0]!.records[0]! as any).recordId).toBe('unknown-r');
    });

    it('change-stream delete (addToFilter=false) for unknown record still records tombstone', async () => {
      // Regression: previously, when the change-stream delete fan-out arrived for a
      // record that wasn't in the SD's per-connection filter, the SD dropped the
      // delete cursor AND did not record the tombstone. Any pre-delete active cursor
      // for the same id that was already queued (e.g. queued before the delete from
      // a parallel `pushActive` path) would then dispatch later and resurrect the
      // record on the CR. Stress test repro: a client reconnected after a server
      // restart, several pre-delete active cursors were queued, the change-stream
      // delete fanned out, was dropped here, then the queued active cursor landed
      // and re-created the record on the client.
      const onDispatch = vi.fn().mockResolvedValue([]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });

      // Step 1: change-stream delete for an unknown record — should be dropped
      // (nothing dispatched) but the id must still go into #deletedRecordIds.
      sd.push([{ collectionName: 'items', records: [makeDeletedCursor('r1', 'u2')] }], false);
      await vi.runAllTimersAsync();
      expect(onDispatch).not.toHaveBeenCalled();

      // Step 2: a stale pre-delete active cursor (authoritative push) for the same
      // id arrives. With the regression in place, this would dispatch and resurrect
      // the record on the CR. With the fix, #deletedRecordIds blocks it.
      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'stale-hash', 'u1')] }], true);
      await vi.runAllTimersAsync();
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('blocks active cursors when id is in deletedRecordIds and filterItem is null', async () => {
      // The "filterItem == null" branch for active cursors must still consult
      // deletedRecordIds — otherwise a stale active could slip through if the
      // collection's filterItem has been cleared.
      const onDispatch = vi.fn().mockResolvedValue([{ collectionName: 'items', successfulRecordIds: ['r1'] }]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });

      // Seed deletedRecordIds via updateFilter (collection has no tracked records)
      sd.updateFilter([{
        collectionName: 'items',
        records: [],
        deletedRecordIds: ['r1'],
      }]);

      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash1', 'u1')] }]);
      await vi.runAllTimersAsync();
      expect(onDispatch).not.toHaveBeenCalled();
    });
  });

  describe('updateFilter clears premature tombstones', () => {
    it('clears tombstone when client reports active record via updateFilter', async () => {
      // Reproduces the post-restart race:
      // 1. Change-stream delete arrives for unknown record → tombstone recorded
      // 2. Client's CD.start() triggers SR → SR calls updateFilter with the record as active
      // 3. SR detects server deleted → pushes authoritative delete cursor
      // Without the fix, the tombstone from step 1 blocks the delete in step 3.
      const onDispatch = vi.fn().mockResolvedValue([{ collectionName: 'items', successfulRecordIds: ['r1'] }]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });

      // Step 1: change-stream delete for unknown record → tombstone
      sd.push([{ collectionName: 'items', records: [makeDeletedCursor('r1', 'u2')] }], false);
      await vi.runAllTimersAsync();
      expect(onDispatch).not.toHaveBeenCalled();

      // Step 2: SR seeds filter — client says it has r1 as active
      sd.updateFilter([{
        collectionName: 'items',
        records: [{ id: 'r1', hash: 'hash1', lastAuditEntryId: 'u1' }],
      }]);

      // Step 3: SR pushes authoritative delete (server has deleted r1)
      sd.push([{ collectionName: 'items', records: [makeDeletedCursor('r1', 'u3')] }], true);
      await vi.runAllTimersAsync();

      // The delete cursor MUST reach the client — tombstone was cleared by updateFilter
      expect(onDispatch).toHaveBeenCalledOnce();
      const arg = onDispatch.mock.calls[0]![0] as MXDBRecordCursors;
      expect(arg[0]!.records).toHaveLength(1);
      expect((arg[0]!.records[0]! as any).recordId).toBe('r1');
    });

    it('does NOT clear tombstone when client reports deleted record via updateFilter', async () => {
      const onDispatch = vi.fn().mockResolvedValue([]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch });

      // Tombstone via change-stream
      sd.push([{ collectionName: 'items', records: [makeDeletedCursor('r1', 'u2')] }], false);
      await vi.runAllTimersAsync();

      // Client reports r1 as deleted (hash == null) — tombstone should NOT be cleared
      sd.updateFilter([{
        collectionName: 'items',
        records: [{ id: 'r1', lastAuditEntryId: 'u1' }], // no hash = deleted
      }]);

      // A stale active cursor should still be blocked
      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'new-hash', 'u3')] }]);
      await vi.runAllTimersAsync();
      expect(onDispatch).not.toHaveBeenCalled();
    });
  });

  describe('SyncPausedError retry', () => {
    it('schedules retry on SyncPausedError and retries after interval', async () => {
      let callCount = 0;
      const onDispatch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new SyncPausedError();
        return [{ collectionName: 'items', successfulRecordIds: ['r1'] }];
      });
      const sd = new ServerDispatcher(mockLogger, { onDispatch, retryInterval: 100 });

      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash1', 'u1')] }]);
      await vi.runAllTimersAsync();

      expect(onDispatch).toHaveBeenCalledTimes(2);
    });
  });

  describe('ignored-record cap (per record id)', () => {
    it('drops a record and logs a detailed error after the client ignores it 3 times while resolving the dispatch', async () => {
      // Client resolves every dispatch (even with an empty []), so the request IS answered, but
      // never includes r1 — a deliberate, repeated refusal. The SD must give up after 3 tries.
      const onDispatch = vi.fn().mockResolvedValue([{ collectionName: 'items', successfulRecordIds: [] }]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch, clientId: 'socket-xyz' });

      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash1', 'u1')] }]);
      await vi.runAllTimersAsync();

      // Sent exactly 3 times, then dropped (no 4th attempt) — the unbounded re-send loop is capped.
      expect(onDispatch).toHaveBeenCalledTimes(3);
      expect(mockLogger.error).toHaveBeenCalledOnce();

      const errorCall = (mockLogger.error as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls[0]!;
      const [message, meta] = errorCall;
      expect(message).toContain('important to investigate');
      expect(message).toMatch(/has NOT stopped/i);
      expect(meta).toMatchObject({
        clientId: 'socket-xyz',
        collectionName: 'items',
        recordId: 'r1',
        consecutiveIgnores: 3,
        cursorType: 'active',
        lastAuditEntryId: 'u1',
        cursorHash: 'hash1',
      });

      // The record is gone from the queue — nothing further is dispatched.
      onDispatch.mockClear();
      await vi.runAllTimersAsync();
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('counts an empty [] response (request answered, nothing acknowledged) toward the cap', async () => {
      // Sending one id and getting [] back is "answered but this id ignored" — it counts.
      const onDispatch = vi.fn().mockResolvedValue([]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch, clientId: 'c' });

      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash1', 'u1')] }]);
      await vi.runAllTimersAsync();

      expect(onDispatch).toHaveBeenCalledTimes(3);
      expect(mockLogger.error).toHaveBeenCalledOnce();
    });

    it('does not count, error, or re-send a record the client explicitly declines', async () => {
      // The client answers the dispatch but reports r1 as declined (e.g. pending C2S merge). The
      // SD must stop re-sending it WITHOUT counting it toward the cap or logging an error.
      const onDispatch = vi.fn().mockResolvedValue([{ collectionName: 'items', successfulRecordIds: [], declinedRecordIds: ['r1'] }]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch, clientId: 'c' });

      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash1', 'u1')] }]);
      await vi.runAllTimersAsync();

      // Sent once, declined, dropped from the queue — never re-sent, never errored.
      expect(onDispatch).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).not.toHaveBeenCalled();

      onDispatch.mockClear();
      await vi.runAllTimersAsync();
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('does not count or drop a record when the dispatch is rejected (no answer at all)', async () => {
      // A rejected dispatch (here SyncPausedError) is NOT an answer, so it must never count toward
      // the ignore cap — the record keeps being retried, never dropped, no error.
      const onDispatch = vi.fn().mockRejectedValue(new SyncPausedError());
      const sd = new ServerDispatcher(mockLogger, { onDispatch, clientId: 'c', retryInterval: 100 });

      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash1', 'u1')] }]);
      await vi.advanceTimersByTimeAsync(450);

      expect(onDispatch.mock.calls.length).toBeGreaterThan(3);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('tracks the streak independently per record id', async () => {
      // r-keep is acked every round; r-drop is always ignored. Only r-drop should be dropped,
      // and r-keep's continuous acks must not interfere with r-drop's streak.
      const onDispatch = vi.fn().mockResolvedValue([{ collectionName: 'items', successfulRecordIds: ['r-keep'] }]);
      const sd = new ServerDispatcher(mockLogger, { onDispatch, clientId: 'c' });

      sd.pause();
      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r-keep', 'h1', 'u1'), makeActiveCursor('r-drop', 'h2', 'u2')] }]);
      sd.resume();
      await vi.runAllTimersAsync();

      expect(mockLogger.error).toHaveBeenCalledOnce();
      const meta = (mockLogger.error as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls[0]![1];
      expect(meta).toMatchObject({ recordId: 'r-drop' });
    });

    it('resets a record\'s streak after it is acknowledged (a later refusal starts from zero)', async () => {
      // Phase 1: ignored twice (count → 2) then acknowledged on the 3rd dispatch (resets to 0).
      let call = 0;
      const onDispatch = vi.fn().mockImplementation(async () => {
        call++;
        if (call === 3) return [{ collectionName: 'items', successfulRecordIds: ['r1'] }];
        return [{ collectionName: 'items', successfulRecordIds: [] }];
      });
      const sd = new ServerDispatcher(mockLogger, { onDispatch, clientId: 'c' });

      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash1', 'u1')] }]);
      await vi.runAllTimersAsync();
      expect(onDispatch).toHaveBeenCalledTimes(3);
      expect(mockLogger.error).not.toHaveBeenCalled();

      // Phase 2: a changed version is now ignored. If the streak reset, it takes a FULL 3 fresh
      // refusals (dispatches 4,5,6) to drop — not 1 (which would mean the count was still at 2).
      onDispatch.mockResolvedValue([{ collectionName: 'items', successfulRecordIds: [] }]);
      sd.push([{ collectionName: 'items', records: [makeActiveCursor('r1', 'hash2', 'u2')] }]);
      await vi.runAllTimersAsync();

      expect(onDispatch).toHaveBeenCalledTimes(6);
      expect(mockLogger.error).toHaveBeenCalledOnce();
    });
  });

});
