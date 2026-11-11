import { describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulidx';
import type { Record } from '@anupheaus/common';
import { AuditEntryType, OperationType, type ServerAuditEntry } from '../../common';
import { compactServerAudit } from './compactServerAudit';

const ENTRY_COUNT = 60;

/** A record created by the seed and changed many times; `writerOf(index)` says who made the change at each index. */
function auditWrittenBy(writerOf: (index: number) => string) {
  const nextId = monotonicFactory();
  const entries: ServerAuditEntry<Record>[] = [{ type: AuditEntryType.Created, id: nextId(1_000), record: { id: 'fit-1', count: 0 } as Record, userId: '__mxdb_system__' }];
  for (let index = 1; index < ENTRY_COUNT; index++) {
    entries.push({ type: AuditEntryType.Updated, id: nextId(1_000 + index), ops: [{ type: OperationType.Replace, path: 'count', value: index }], userId: writerOf(index) });
  }
  return { id: 'fit-1', entries };
}

describe('compactServerAudit attribution', () => {
  it('attributes the snapshot to the last person among the folded entries, never to a change made outside the app (sc-5449)', () => {
    // A fitter's change early on, then only the server and direct changes to the database.
    const audit = auditWrittenBy(index => (index === 1 ? 'fitter-1' : index % 2 === 0 ? '__mxdb_direct_write__' : '__mxdb_system__'));

    const [snapshot] = compactServerAudit(audit).entries;

    expect([snapshot!.type, snapshot!.userId]).toEqual([AuditEntryType.Created, 'fitter-1']);
  });

  it('keeps every entry\'s own attribution, a change made outside the app included, among the entries it keeps', () => {
    const audit = auditWrittenBy(index => (index === ENTRY_COUNT - 1 ? '__mxdb_direct_write__' : 'office-1'));

    const compacted = compactServerAudit(audit).entries;

    expect(compacted.length).toBeLessThan(ENTRY_COUNT);
    expect(compacted.at(-1)!.userId).toBe('__mxdb_direct_write__');
  });
});
