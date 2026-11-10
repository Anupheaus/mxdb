import { describe, expect, it } from 'vitest';
import { AuditEntryType, OperationType, type AuditEntry } from '../../../common';
import { carriesChange } from './carriesChange';

const ID = '01JX0000000000000000000000';

describe('carriesChange (sc-5471)', () => {
  it.each([
    ['an Updated with ops', { type: AuditEntryType.Updated, id: ID, ops: [{ type: OperationType.Replace, path: 'name', value: 'x' }] }, true],
    ['an Updated with no ops (the same value again)', { type: AuditEntryType.Updated, id: ID, ops: [] }, false],
    ['an Updated with malformed ops', { type: AuditEntryType.Updated, id: ID }, false],
    ['a Branched anchor', { type: AuditEntryType.Branched, id: ID }, false],
    ['a Created', { type: AuditEntryType.Created, id: ID, record: { id: 'r1' } }, true],
    ['a Deleted', { type: AuditEntryType.Deleted, id: ID }, true],
    ['a Restored', { type: AuditEntryType.Restored, id: ID }, true],
  ])('%s → %s', (_label, entry, expected) => {
    expect(carriesChange(entry as unknown as AuditEntry)).toBe(expected);
  });
});
