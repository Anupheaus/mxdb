import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@anupheaus/common';
import { ServerDispatcher } from './ServerDispatcher';
import type { MXDBActiveRecordCursor, MXDBDeletedRecordCursor, MXDBRecordCursors, MXDBSyncEngineResponse } from './models';

/**
 * An eviction (`isEviction` on a delete cursor) tells a client to drop a record it may no longer hold — one that has
 * left its read gate (sc-584). It is NOT a delete: the SD must forget the record without tombstoning it, so the record
 * can reach the client again the moment the gate lets it back in.
 */

const COLLECTION = 'items';
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() } as unknown as Logger;

type ActiveCursorWithHash = MXDBActiveRecordCursor & { hash: string };
const active = (id: string, lastAuditEntryId: string): ActiveCursorWithHash => ({ record: { id }, lastAuditEntryId, hash: `hash-${id}-${lastAuditEntryId}` });
const removed = (recordId: string, lastAuditEntryId: string): MXDBDeletedRecordCursor => ({ recordId, lastAuditEntryId });
const evicted = (recordId: string): MXDBDeletedRecordCursor => ({ recordId, lastAuditEntryId: '', isEviction: true });
const batch = (...records: (MXDBActiveRecordCursor | MXDBDeletedRecordCursor)[]): MXDBRecordCursors => [{ collectionName: COLLECTION, records }];

interface DispatcherHarness {
  sd: ServerDispatcher;
  dispatched: MXDBRecordCursors[];
  /** Records the client declines rather than acknowledges. */
  declining: Set<string>;
}

function makeDispatcher(): DispatcherHarness {
  const dispatched: MXDBRecordCursors[] = [];
  const declining = new Set<string>();
  const sd = new ServerDispatcher(logger, {
    onDispatch: async (payload: MXDBRecordCursors): Promise<MXDBSyncEngineResponse> => {
      dispatched.push(payload);
      return payload.map(({ collectionName, records }) => {
        const ids = records.map(cursor => ('record' in cursor ? cursor.record.id : cursor.recordId));
        return { collectionName, successfulRecordIds: ids.filter(id => !declining.has(id)), declinedRecordIds: ids.filter(id => declining.has(id)) };
      });
    },
  });
  return { sd, dispatched, declining };
}

/** The client holds `id`: an authoritative push it acknowledged. */
async function hold({ sd, dispatched }: DispatcherHarness, id: string): Promise<void> {
  sd.push(batch(active(id, 'u1')));
  await vi.runAllTimersAsync();
  dispatched.length = 0;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('ServerDispatcher evictions', () => {
  it('sends a change-stream eviction only to a client that holds the record', async () => {
    const harness = makeDispatcher();
    await hold(harness, 'held');
    harness.sd.push(batch(evicted('held'), evicted('never-held')), false);
    await vi.runAllTimersAsync();
    expect(harness.dispatched).toEqual([batch(evicted('held'))]);
  });

  it('always sends an authoritative eviction (a client answered for an id it claimed)', async () => {
    const harness = makeDispatcher();
    harness.sd.push(batch(evicted('claimed')));
    await vi.runAllTimersAsync();
    expect(harness.dispatched).toEqual([batch(evicted('claimed'))]);
  });

  it('forgets the record without a tombstone, so it comes back when the gate lets it in again', async () => {
    const harness = makeDispatcher();
    await hold(harness, 'r1');
    harness.sd.push(batch(evicted('r1')), false);
    await vi.runAllTimersAsync();
    harness.dispatched.length = 0;

    // Forgotten: a later change-stream update is not sent...
    harness.sd.push(batch(active('r1', 'u2')), false);
    await vi.runAllTimersAsync();
    expect(harness.dispatched).toEqual([]);
    // ...but not tombstoned: an authoritative push (a fresh read under the new gate) delivers it again.
    harness.sd.push(batch(active('r1', 'u3')));
    await vi.runAllTimersAsync();
    expect(harness.dispatched).toEqual([batch(active('r1', 'u3'))]);
  });

  it('forgets the record even when the client declines the eviction (it still has changes to sync)', async () => {
    const harness = makeDispatcher();
    await hold(harness, 'r1');
    harness.declining.add('r1');
    harness.sd.push(batch(evicted('r1')), false);
    await vi.runAllTimersAsync();
    harness.dispatched.length = 0;

    harness.sd.push(batch(active('r1', 'u2')), false);
    await vi.runAllTimersAsync();
    expect(harness.dispatched).toEqual([]);
  });

  it('is sent even for a tombstoned record — it carries nothing to leak', async () => {
    const harness = makeDispatcher();
    await hold(harness, 'r1');
    harness.sd.push(batch(removed('r1', 'u2')), false);
    await vi.runAllTimersAsync();
    harness.dispatched.length = 0;

    harness.sd.push(batch(evicted('r1')));
    await vi.runAllTimersAsync();
    expect(harness.dispatched).toEqual([batch(evicted('r1'))]);
  });

  describe('squashed with other cursors for the same record', () => {
    async function dispatchedAfter(...cursors: MXDBRecordCursors[]): Promise<MXDBRecordCursors[]> {
      const harness = makeDispatcher();
      await hold(harness, 'r1');
      harness.sd.pause();
      cursors.forEach(cursor => harness.sd.push(cursor));
      harness.sd.resume();
      await vi.runAllTimersAsync();
      return harness.dispatched;
    }

    it('never beats a real delete, whichever came first', async () => {
      expect(await dispatchedAfter(batch(removed('r1', 'u2')), batch(evicted('r1')))).toEqual([batch(removed('r1', 'u2'))]);
      expect(await dispatchedAfter(batch(evicted('r1')), batch(removed('r1', 'u2')))).toEqual([batch(removed('r1', 'u2'))]);
    });

    it('loses to a later active cursor (back in the gate) and beats an earlier one (left it)', async () => {
      expect(await dispatchedAfter(batch(evicted('r1')), batch(active('r1', 'u2')))).toEqual([batch(active('r1', 'u2'))]);
      expect(await dispatchedAfter(batch(active('r1', 'u2')), batch(evicted('r1')))).toEqual([batch(evicted('r1'))]);
    });
  });
});
