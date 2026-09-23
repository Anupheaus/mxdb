import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@anupheaus/common';
import { ServerDispatcher } from './ServerDispatcher';
import type {
  MXDBActiveRecordCursor,
  MXDBDeletedRecordCursor,
  MXDBRecordCursors,
  MXDBSyncEngineResponse,
  ServerDispatcherFilter,
} from './models';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const COLLECTION = 'items';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() } as unknown as Logger;

type ActiveCursorWithHash = MXDBActiveRecordCursor & { hash: string };

const active = (id: string, lastAuditEntryId: string, hash = `hash-${lastAuditEntryId}`): ActiveCursorWithHash =>
  ({ record: { id }, lastAuditEntryId, hash });
const removed = (recordId: string, lastAuditEntryId: string): MXDBDeletedRecordCursor => ({ recordId, lastAuditEntryId });
const batch = (...records: (MXDBActiveRecordCursor | MXDBDeletedRecordCursor)[]): MXDBRecordCursors =>
  [{ collectionName: COLLECTION, records }];

/** Acknowledges every record it is sent, recording each payload. */
function makeAckingDispatcher() {
  const dispatched: MXDBRecordCursors[] = [];
  const onDispatch = vi.fn(async (payload: MXDBRecordCursors): Promise<MXDBSyncEngineResponse> => {
    dispatched.push(payload);
    return payload.map(({ collectionName, records }) => ({
      collectionName,
      successfulRecordIds: records.map(cursor => ('record' in cursor ? cursor.record.id : cursor.recordId)),
    }));
  });
  const sd = new ServerDispatcher(logger, { onDispatch });
  return { sd, dispatched };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ─── pause / resume ───────────────────────────────────────────────────────────

describe('ServerDispatcher resume without a prior pause', () => {
  it('does not dispatch anything', async () => {
    const { sd, dispatched } = makeAckingDispatcher();

    sd.resume();
    await vi.runAllTimersAsync();

    expect(dispatched).toEqual([]);
  });
});

// ─── Squashing queued cursors ─────────────────────────────────────────────────

describe('ServerDispatcher squashing of queued cursors', () => {
  it('keeps the newer active cursor when an older one is queued after it', async () => {
    const { sd, dispatched } = makeAckingDispatcher();
    sd.pause();
    sd.push(batch(active('r1', 'u5')));
    sd.push(batch(active('r1', 'u3')));

    sd.resume();
    await vi.runAllTimersAsync();

    expect(dispatched).toEqual([batch(active('r1', 'u5'))]);
  });

  it('keeps a queued delete when an active cursor for the same record follows it', async () => {
    const { sd, dispatched } = makeAckingDispatcher();
    sd.pause();
    sd.push(batch(removed('r1', 'u3')));
    sd.push(batch(active('r1', 'u9')));

    sd.resume();
    await vi.runAllTimersAsync();

    expect(dispatched).toEqual([batch(removed('r1', 'u3'))]);
  });

  it('delivers a newer change-stream cursor for an unknown record when an older authoritative push for it is also queued', async () => {
    const { sd, dispatched } = makeAckingDispatcher();
    sd.pause();
    sd.push(batch(active('r1', 'u5')), false);
    sd.push(batch(active('r1', 'u3')), true);

    sd.resume();
    await vi.runAllTimersAsync();

    expect(dispatched).toEqual([batch(active('r1', 'u5'))]);
  });

  it('delivers a delete for an unknown record when an authoritative active push for it is also queued', async () => {
    const { sd, dispatched } = makeAckingDispatcher();
    sd.pause();
    sd.push(batch(removed('r1', 'u5')), false);
    sd.push(batch(active('r1', 'u3')), true);

    sd.resume();
    await vi.runAllTimersAsync();

    expect(dispatched).toEqual([batch(removed('r1', 'u5'))]);
  });
});

// ─── Filter gates ─────────────────────────────────────────────────────────────

describe('ServerDispatcher filter gates', () => {
  it('drops a change-stream active cursor for a record the client has never acknowledged', async () => {
    const { sd, dispatched } = makeAckingDispatcher();

    sd.push(batch(active('r1', 'u1')), false);
    await vi.runAllTimersAsync();

    expect(dispatched).toEqual([]);
  });

  it('re-sends a pending deletion at its newer ULID when an older delete cursor arrives', async () => {
    const { sd, dispatched } = makeAckingDispatcher();
    const pendingDelete: ServerDispatcherFilter = { collectionName: COLLECTION, records: [{ id: 'r1', lastAuditEntryId: 'u7' }] };
    sd.updateFilter([pendingDelete]);

    sd.push(batch(removed('r1', 'u3')));
    await vi.runAllTimersAsync();

    expect(dispatched).toEqual([batch(removed('r1', 'u7'))]);
  });
});

// ─── Declined deletes ─────────────────────────────────────────────────────────

describe('ServerDispatcher after a client declines a delete for a record it never acknowledged', () => {
  const otherFilterRecords: [string, ServerDispatcherFilter[]][] = [
    ['no other records are tracked for the collection', []],
    ['other records are tracked for the collection', [{ collectionName: COLLECTION, records: [{ id: 'other', hash: 'h', lastAuditEntryId: 'u1' }] }]],
  ];

  it.each(otherFilterRecords)('converts a later change-stream update into the pending delete when %s', async (_label, filters) => {
    const dispatched: MXDBRecordCursors[] = [];
    const responses: MXDBSyncEngineResponse[] = [
      [{ collectionName: COLLECTION, successfulRecordIds: [], declinedRecordIds: ['r1'] }],
      [{ collectionName: COLLECTION, successfulRecordIds: ['r1'] }],
    ];
    const onDispatch = vi.fn(async (payload: MXDBRecordCursors) => {
      dispatched.push(payload);
      return responses.shift() ?? [];
    });
    const sd = new ServerDispatcher(logger, { onDispatch });
    sd.updateFilter(filters);
    sd.push(batch(removed('r1', 'u4')));
    await vi.runAllTimersAsync();

    sd.push(batch(active('r1', 'u6')), false);
    await vi.runAllTimersAsync();

    expect(dispatched[1]).toEqual(batch(removed('r1', 'u4')));
  });
});
