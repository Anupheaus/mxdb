import { describe, it, expect } from 'vitest';
import type { Record as MXDBRecord } from '@anupheaus/common';
import type {
  MXDBActiveRecordCursor,
  MXDBActiveRecordState,
  MXDBDeletedRecordCursor,
  MXDBDeletedRecordState,
  MXDBRecordCursors,
  MXDBSyncEngineResponse,
} from './models';
import {
  addIdsToResponse,
  getCursorId,
  getStateId,
  getSuccessfulIds,
  isActiveCursor,
  isActiveRecordState,
  isDeletedCursor,
  isDeletedRecordState,
  squashCursors,
} from './utils';

type TestRecord = MXDBRecord & { name?: string };

const COLLECTION_ITEMS = 'items';
const COLLECTION_ORDERS = 'orders';

const ULID_EARLIER = '01H000000000000000000000A0';
const ULID_LATER = '01H000000000000000000000B0';
const ULID_LATEST = '01H000000000000000000000C0';

function makeRecord(id: string, name?: string): TestRecord {
  return { id, name };
}

function makeActiveState(id: string, name?: string): MXDBActiveRecordState<TestRecord> {
  return { record: makeRecord(id, name), audit: [] };
}

function makeDeletedState(recordId: string): MXDBDeletedRecordState {
  return { recordId, audit: [] };
}

function makeActiveCursor(id: string, lastAuditEntryId: string, name?: string): MXDBActiveRecordCursor<TestRecord> {
  return { record: makeRecord(id, name), lastAuditEntryId };
}

function makeDeletedCursor(recordId: string, lastAuditEntryId: string): MXDBDeletedRecordCursor {
  return { recordId, lastAuditEntryId };
}

function makeBatch(collectionName: string, records: (MXDBActiveRecordCursor<TestRecord> | MXDBDeletedRecordCursor)[]): MXDBRecordCursors<TestRecord> {
  return [{ collectionName, records }];
}

// ─── Type guards ───────────────────────────────────────────────────────────────

describe('isActiveRecordState', () => {
  const activeCases: Array<[string, MXDBActiveRecordState<TestRecord> | MXDBDeletedRecordState]> = [
    ['state with record and audit', makeActiveState('r1', 'Alice')],
    ['state with record only (no name)', makeActiveState('r2')],
  ];

  const deletedCases: Array<[string, MXDBActiveRecordState<TestRecord> | MXDBDeletedRecordState]> = [
    ['state with recordId', makeDeletedState('r1')],
  ];

  it.each(activeCases)('returns true for %s', (_label, state) => {
    expect(isActiveRecordState(state)).toBe(true);
  });

  it.each(deletedCases)('returns false for %s', (_label, state) => {
    expect(isActiveRecordState(state)).toBe(false);
  });
});

describe('isDeletedRecordState', () => {
  const deletedCases: Array<[string, MXDBActiveRecordState<TestRecord> | MXDBDeletedRecordState]> = [
    ['state with recordId', makeDeletedState('r1')],
  ];

  const activeCases: Array<[string, MXDBActiveRecordState<TestRecord> | MXDBDeletedRecordState]> = [
    ['state with record and audit', makeActiveState('r1', 'Alice')],
    ['state with record only (no name)', makeActiveState('r2')],
  ];

  it.each(deletedCases)('returns true for %s', (_label, state) => {
    expect(isDeletedRecordState(state)).toBe(true);
  });

  it.each(activeCases)('returns false for %s', (_label, state) => {
    expect(isDeletedRecordState(state)).toBe(false);
  });
});

describe('isActiveCursor', () => {
  const activeCases: Array<[string, MXDBActiveRecordCursor<TestRecord> | MXDBDeletedRecordCursor]> = [
    ['cursor with record', makeActiveCursor('r1', ULID_EARLIER, 'Alice')],
    ['cursor with record and no name', makeActiveCursor('r2', ULID_EARLIER)],
  ];

  const deletedCases: Array<[string, MXDBActiveRecordCursor<TestRecord> | MXDBDeletedRecordCursor]> = [
    ['cursor with recordId', makeDeletedCursor('r1', ULID_EARLIER)],
  ];

  it.each(activeCases)('returns true for %s', (_label, cursor) => {
    expect(isActiveCursor(cursor)).toBe(true);
  });

  it.each(deletedCases)('returns false for %s', (_label, cursor) => {
    expect(isActiveCursor(cursor)).toBe(false);
  });
});

describe('isDeletedCursor', () => {
  const deletedCases: Array<[string, MXDBActiveRecordCursor<TestRecord> | MXDBDeletedRecordCursor]> = [
    ['cursor with recordId', makeDeletedCursor('r1', ULID_EARLIER)],
  ];

  const activeCases: Array<[string, MXDBActiveRecordCursor<TestRecord> | MXDBDeletedRecordCursor]> = [
    ['cursor with record', makeActiveCursor('r1', ULID_EARLIER, 'Alice')],
    ['cursor with record and no name', makeActiveCursor('r2', ULID_EARLIER)],
  ];

  it.each(deletedCases)('returns true for %s', (_label, cursor) => {
    expect(isDeletedCursor(cursor)).toBe(true);
  });

  it.each(activeCases)('returns false for %s', (_label, cursor) => {
    expect(isDeletedCursor(cursor)).toBe(false);
  });
});

// ─── Mutual exclusivity ────────────────────────────────────────────────────────

describe('type guard pairs are mutually exclusive', () => {
  it('isActiveRecordState and isDeletedRecordState are inverses', () => {
    const active = makeActiveState('r1');
    const deleted = makeDeletedState('r1');
    expect(isActiveRecordState(active)).toBe(!isDeletedRecordState(active));
    expect(isActiveRecordState(deleted)).toBe(!isDeletedRecordState(deleted));
  });

  it('isActiveCursor and isDeletedCursor are inverses', () => {
    const active = makeActiveCursor('r1', ULID_EARLIER);
    const deleted = makeDeletedCursor('r1', ULID_EARLIER);
    expect(isActiveCursor(active)).toBe(!isDeletedCursor(active));
    expect(isActiveCursor(deleted)).toBe(!isDeletedCursor(deleted));
  });
});

// ─── ID helpers ───────────────────────────────────────────────────────────────

describe('getCursorId', () => {
  it('returns record.id for an active cursor', () => {
    const cursor = makeActiveCursor('r42', ULID_EARLIER, 'Bob');
    expect(getCursorId(cursor)).toBe('r42');
  });

  it('returns recordId for a deleted cursor', () => {
    const cursor = makeDeletedCursor('r99', ULID_EARLIER);
    expect(getCursorId(cursor)).toBe('r99');
  });
});

describe('getStateId', () => {
  it('returns record.id for an active state', () => {
    const state = makeActiveState('r7', 'Carol');
    expect(getStateId(state)).toBe('r7');
  });

  it('returns recordId for a deleted state', () => {
    const state = makeDeletedState('r8');
    expect(getStateId(state)).toBe('r8');
  });
});

// ─── Response helpers ─────────────────────────────────────────────────────────

describe('getSuccessfulIds', () => {
  it('returns ids for a matching collection', () => {
    const response: MXDBSyncEngineResponse = [
      { collectionName: COLLECTION_ITEMS, successfulRecordIds: ['r1', 'r2'] },
    ];
    expect(getSuccessfulIds(response, COLLECTION_ITEMS)).toEqual(['r1', 'r2']);
  });

  it('returns an empty array when the collection is not in the response', () => {
    const response: MXDBSyncEngineResponse = [
      { collectionName: COLLECTION_ITEMS, successfulRecordIds: ['r1'] },
    ];
    expect(getSuccessfulIds(response, COLLECTION_ORDERS)).toEqual([]);
  });

  it('returns an empty array for an empty response', () => {
    expect(getSuccessfulIds([], COLLECTION_ITEMS)).toEqual([]);
  });
});

describe('addIdsToResponse', () => {
  it('returns the original reference when ids is empty', () => {
    const response: MXDBSyncEngineResponse = [
      { collectionName: COLLECTION_ITEMS, successfulRecordIds: ['r1'] },
    ];
    const result = addIdsToResponse(response, COLLECTION_ITEMS, []);
    expect(result).toBe(response);
  });

  it('appends a new collection entry when the collection is not present', () => {
    const response: MXDBSyncEngineResponse = [];
    const result = addIdsToResponse(response, COLLECTION_ITEMS, ['r1', 'r2']);
    expect(result).toEqual([{ collectionName: COLLECTION_ITEMS, successfulRecordIds: ['r1', 'r2'] }]);
  });

  it('merges ids into an existing collection entry', () => {
    const response: MXDBSyncEngineResponse = [
      { collectionName: COLLECTION_ITEMS, successfulRecordIds: ['r1'] },
    ];
    const result = addIdsToResponse(response, COLLECTION_ITEMS, ['r2', 'r3']);
    expect(result.find(r => r.collectionName === COLLECTION_ITEMS)?.successfulRecordIds).toEqual(['r1', 'r2', 'r3']);
  });

  it('deduplicates ids when merging into an existing collection', () => {
    const response: MXDBSyncEngineResponse = [
      { collectionName: COLLECTION_ITEMS, successfulRecordIds: ['r1', 'r2'] },
    ];
    const result = addIdsToResponse(response, COLLECTION_ITEMS, ['r2', 'r3']);
    expect(result.find(r => r.collectionName === COLLECTION_ITEMS)?.successfulRecordIds).toEqual(['r1', 'r2', 'r3']);
  });

  it('deduplicates ids within the new ids list itself', () => {
    const response: MXDBSyncEngineResponse = [];
    const result = addIdsToResponse(response, COLLECTION_ITEMS, ['r1', 'r1', 'r2']);
    expect(result.find(r => r.collectionName === COLLECTION_ITEMS)?.successfulRecordIds).toEqual(['r1', 'r2']);
  });

  it('does not mutate the original response array', () => {
    const response: MXDBSyncEngineResponse = [
      { collectionName: COLLECTION_ITEMS, successfulRecordIds: ['r1'] },
    ];
    const originalLength = response.length;
    const originalIds = [...response[0]!.successfulRecordIds];

    addIdsToResponse(response, COLLECTION_ITEMS, ['r2']);

    expect(response).toHaveLength(originalLength);
    expect(response[0]!.successfulRecordIds).toEqual(originalIds);
  });

  it('does not affect other collection entries when adding to a specific collection', () => {
    const response: MXDBSyncEngineResponse = [
      { collectionName: COLLECTION_ITEMS, successfulRecordIds: ['r1'] },
      { collectionName: COLLECTION_ORDERS, successfulRecordIds: ['o1'] },
    ];
    const result = addIdsToResponse(response, COLLECTION_ITEMS, ['r2']);
    expect(result.find(r => r.collectionName === COLLECTION_ORDERS)?.successfulRecordIds).toEqual(['o1']);
  });
});

// ─── squashCursors ────────────────────────────────────────────────────────────

describe('squashCursors', () => {
  it('returns an empty result for an empty queue', () => {
    expect(squashCursors([])).toEqual([]);
  });

  it('returns the same logical content for a single batch', () => {
    const cursor = makeActiveCursor('r1', ULID_EARLIER, 'Alice');
    const batch = makeBatch(COLLECTION_ITEMS, [cursor]);
    const result = squashCursors([batch]);

    expect(result).toHaveLength(1);
    expect(result[0]!.collectionName).toBe(COLLECTION_ITEMS);
    expect(result[0]!.records).toHaveLength(1);
    expect(result[0]!.records[0]).toBe(cursor);
  });

  it('newer update wins over older update for the same record', () => {
    const older = makeActiveCursor('r1', ULID_EARLIER, 'v1');
    const newer = makeActiveCursor('r1', ULID_LATER, 'v2');
    const result = squashCursors([
      makeBatch(COLLECTION_ITEMS, [older]),
      makeBatch(COLLECTION_ITEMS, [newer]),
    ]);

    const record = result[0]!.records[0] as MXDBActiveRecordCursor<TestRecord>;
    expect(record.record.name).toBe('v2');
    expect(record.lastAuditEntryId).toBe(ULID_LATER);
  });

  it('older update does not displace a newer update already seen', () => {
    const newer = makeActiveCursor('r1', ULID_LATER, 'v2');
    const older = makeActiveCursor('r1', ULID_EARLIER, 'v1');
    const result = squashCursors([
      makeBatch(COLLECTION_ITEMS, [newer]),
      makeBatch(COLLECTION_ITEMS, [older]),
    ]);

    const record = result[0]!.records[0] as MXDBActiveRecordCursor<TestRecord>;
    expect(record.record.name).toBe('v2');
    expect(record.lastAuditEntryId).toBe(ULID_LATER);
  });

  it('delete wins when it arrives after an active cursor', () => {
    const active = makeActiveCursor('r1', ULID_EARLIER, 'Alice');
    const deleted = makeDeletedCursor('r1', ULID_LATER);
    const result = squashCursors([
      makeBatch(COLLECTION_ITEMS, [active]),
      makeBatch(COLLECTION_ITEMS, [deleted]),
    ]);

    const record = result[0]!.records[0]! as MXDBDeletedRecordCursor;
    expect(isDeletedCursor(record)).toBe(true);
    expect(record.lastAuditEntryId).toBe(ULID_LATER);
  });

  it('delete wins even when the active cursor has a newer ULID', () => {
    const deleted = makeDeletedCursor('r1', ULID_EARLIER);
    const active = makeActiveCursor('r1', ULID_LATEST, 'Alice');
    const result = squashCursors([
      makeBatch(COLLECTION_ITEMS, [deleted]),
      makeBatch(COLLECTION_ITEMS, [active]),
    ]);

    const record = result[0]!.records[0]! as MXDBDeletedRecordCursor;
    expect(isDeletedCursor(record)).toBe(true);
    expect(record.lastAuditEntryId).toBe(ULID_EARLIER);
  });

  it('preserves multiple collections independently', () => {
    const itemCursor = makeActiveCursor('r1', ULID_EARLIER, 'Item');
    const orderCursor = makeActiveCursor('o1', ULID_EARLIER, 'Order');
    const result = squashCursors([
      [
        { collectionName: COLLECTION_ITEMS, records: [itemCursor] },
        { collectionName: COLLECTION_ORDERS, records: [orderCursor] },
      ],
    ]);

    expect(result).toHaveLength(2);
    const itemResult = result.find(r => r.collectionName === COLLECTION_ITEMS);
    const orderResult = result.find(r => r.collectionName === COLLECTION_ORDERS);
    expect(itemResult?.records).toHaveLength(1);
    expect(orderResult?.records).toHaveLength(1);
  });

  it('treats the same record id in different collections independently', () => {
    const itemActive = makeActiveCursor('r1', ULID_EARLIER, 'item-v1');
    const itemDeleted = makeDeletedCursor('r1', ULID_LATER);
    const orderActive = makeActiveCursor('r1', ULID_LATER, 'order-v2');

    const result = squashCursors([
      [
        { collectionName: COLLECTION_ITEMS, records: [itemActive] },
        { collectionName: COLLECTION_ORDERS, records: [orderActive] },
      ],
      [
        { collectionName: COLLECTION_ITEMS, records: [itemDeleted] },
      ],
    ]);

    const itemResult = result.find(r => r.collectionName === COLLECTION_ITEMS);
    const orderResult = result.find(r => r.collectionName === COLLECTION_ORDERS);

    expect(isDeletedCursor(itemResult!.records[0]!)).toBe(true);
    expect(isActiveCursor(orderResult!.records[0]!)).toBe(true);
    const orderRecord = orderResult!.records[0] as MXDBActiveRecordCursor<TestRecord>;
    expect(orderRecord.record.name).toBe('order-v2');
  });

  it('produces exactly one record per unique id per collection when the same record appears across batches', () => {
    const v1 = makeActiveCursor('r1', ULID_EARLIER, 'v1');
    const v2 = makeActiveCursor('r1', ULID_LATER, 'v2');
    const v3 = makeActiveCursor('r1', ULID_LATEST, 'v3');
    const result = squashCursors([
      makeBatch(COLLECTION_ITEMS, [v1]),
      makeBatch(COLLECTION_ITEMS, [v2]),
      makeBatch(COLLECTION_ITEMS, [v3]),
    ]);

    expect(result[0]!.records).toHaveLength(1);
    const record = result[0]!.records[0] as MXDBActiveRecordCursor<TestRecord>;
    expect(record.record.name).toBe('v3');
  });
});
