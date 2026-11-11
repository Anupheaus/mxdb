import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import type { Record } from '@anupheaus/common';
import { AuditEntryType, OperationType, type AuditEntry } from '../../../common';
import { auditor } from '../../../common/auditor';
import { directWriteEntryFor } from './directWriteEntry';
import { dbUtils } from './db-transforms';

interface Fit extends Record {
  status: string;
  notes?: string | null;
  startsAt?: DateTime;
  blinds?: { id: string; state: string }[];
}

const CREATED_ID = '01JX0000000000000000000000';
const EDITED_ID = '01JX0000010000000000000000';
const NEXT_ID = 'NEXT';

const booked: Fit = { id: 'fit-1', status: 'booked', notes: '', startsAt: DateTime.fromISO('2026-11-10T09:00:00Z'), blinds: [{ id: 'b1', state: 'ordered' }] };
const history: AuditEntry<Fit>[] = [
  { type: AuditEntryType.Created, id: CREATED_ID, record: booked },
  { type: AuditEntryType.Updated, id: EDITED_ID, ops: [{ type: OperationType.Replace, path: 'notes', value: 'gate code' }] },
];
const asHistoryEnds: Fit = { ...booked, notes: 'gate code' };

/** The record as it reads back from the database after `change` was written to it directly. */
const storedAfter = (change: Partial<Fit>): Fit => dbUtils.asStored({ ...asHistoryEnds, ...change });

const entryFor = (entries: AuditEntry<Fit>[], storedRecord: Fit) =>
  directWriteEntryFor({ entries, storedRecord, generateEntryId: lastEntryId => `${NEXT_ID}>${lastEntryId}` });

describe('directWriteEntryFor (sc-5449)', () => {
  // Every kind of direct change, each expected entry written out by hand.
  it.each([
    ['a field set (a cancellation)', { status: 'cancelled' }, [{ type: OperationType.Replace, path: 'status', value: 'cancelled' }]],
    ['a date moved', { startsAt: DateTime.fromISO('2026-11-11T14:30:00Z') }, [{ type: OperationType.Replace, path: 'startsAt', value: '2026-11-11T14:30:00.000+00:00' }]],
    ['a field cleared to null', { notes: null }, [{ type: OperationType.Replace, path: 'notes', value: null }]],
    ['a list item changed', { blinds: [{ id: 'b1', state: 'fitted' }] }, [{ type: OperationType.Replace, path: 'blinds.[id:b1].state', value: 'fitted' }]],
  ] as const)('records %s as one update made outside the app, dated after the history', (_label, change, ops) => {
    const entry = entryFor(history, storedAfter(change as Partial<Fit>));
    expect(entry).toEqual({ type: AuditEntryType.Updated, id: `${NEXT_ID}>${EDITED_ID}`, ops, userId: '__mxdb_direct_write__' });
  });

  it('replayed after the history, the entry gives exactly the stored record', () => {
    const stored = storedAfter({ status: 'cancelled', notes: 'left by support', startsAt: DateTime.fromISO('2026-11-11T14:30:00Z'), blinds: [{ id: 'b1', state: 'fitted' }] });
    const entry = entryFor(history, stored)!;
    const replayed = auditor.createRecordFrom({ id: 'fit-1', entries: [...history, { ...entry, id: '01JX0000020000000000000000' }] });
    expect(dbUtils.asStored(replayed!)).toEqual(stored);
  });

  it('records nothing when the history already ends in the stored record, however it reads back', () => {
    expect(entryFor(history, storedAfter({}))).toBeUndefined();
    // A field written as undefined is stored, in the record and its history alike, as null: not a change.
    const readBackHistory: AuditEntry<Fit>[] = [{ type: AuditEntryType.Created, id: CREATED_ID, record: dbUtils.asStored({ ...booked, notes: undefined }) }];
    expect(entryFor(readBackHistory, dbUtils.asStored({ ...booked, notes: undefined }))).toBeUndefined();
  });

  it('records nothing for a record with no history, or one whose history ends deleted', () => {
    expect(entryFor([], storedAfter({ status: 'cancelled' }))).toBeUndefined();
    const deleted: AuditEntry<Fit>[] = [...history, { type: AuditEntryType.Deleted, id: '01JX0000020000000000000000' }];
    expect(entryFor(deleted, storedAfter({ status: 'cancelled' }))).toBeUndefined();
  });

  it('dates the entry from the newest entry of the history, whatever order the history is held in', () => {
    const entry = entryFor([history[1]!, history[0]!], storedAfter({ status: 'cancelled' }));
    expect(entry?.id).toBe(`${NEXT_ID}>${EDITED_ID}`);
  });
});
