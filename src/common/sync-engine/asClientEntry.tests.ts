import { describe, expect, it } from 'vitest';
import { AuditEntryType, OperationType, type AuditEntry } from '../auditor/auditor-models';
import { asClientEntry } from './asClientEntry';

const ID = '01JX0000000000000000000000';
const RECORD = { id: 'r1', name: 'mine' };
const OPS = [{ type: OperationType.Replace, path: 'name', value: 'x' }];
/** Everything only the server may set on an entry, as a hostile client would send it. */
const SERVER_ONLY = { userId: '__mxdb_direct_write__', reset: true, compaction: { historyStart: ID, clocks: [] }, extra: 'anything' };

describe('asClientEntry (sc-5449)', () => {
  // Expected shapes written out by hand: a client keeps only its content.
  it.each([
    ['Created', { type: AuditEntryType.Created, id: ID, record: RECORD }, { type: AuditEntryType.Created, id: ID, record: RECORD }],
    ['Updated', { type: AuditEntryType.Updated, id: ID, ops: OPS }, { type: AuditEntryType.Updated, id: ID, ops: OPS }],
    ['Deleted (with a snapshot it may not set)', { type: AuditEntryType.Deleted, id: ID, record: RECORD }, { type: AuditEntryType.Deleted, id: ID }],
    ['Restored with a record', { type: AuditEntryType.Restored, id: ID, record: RECORD }, { type: AuditEntryType.Restored, id: ID, record: RECORD }],
    ['Restored without a record', { type: AuditEntryType.Restored, id: ID }, { type: AuditEntryType.Restored, id: ID }],
    ['Branched', { type: AuditEntryType.Branched, id: ID }, { type: AuditEntryType.Branched, id: ID }],
  ])('a %s entry keeps its content and loses every server-only field', (_label, entry, expected) => {
    expect(asClientEntry({ ...entry, ...SERVER_ONLY } as unknown as AuditEntry)).toEqual(expected);
  });

  it.each(['__mxdb_direct_write__', '__mxdb_system__', 'another-user', '', 42, null])('drops a claimed userId of %j', claimed => {
    expect('userId' in asClientEntry({ type: AuditEntryType.Updated, id: ID, ops: OPS, userId: claimed } as unknown as AuditEntry)).toBe(false);
  });
});
