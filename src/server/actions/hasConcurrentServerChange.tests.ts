import { describe, it, expect } from 'vitest';
import { AuditEntryType, type AuditEntry } from '../../common/auditor';
import { hasConcurrentServerChange } from './hasConcurrentServerChange';

function entry(type: AuditEntryType, sequence: number): AuditEntry {
  return { type, id: `01J${String(sequence).padStart(23, '0')}` } as AuditEntry;
}

describe('hasConcurrentServerChange', () => {
  it('is false when the merged audit holds only what the client sent', () => {
    const clientEntries = [entry(AuditEntryType.Created, 1), entry(AuditEntryType.Updated, 2)];

    expect(hasConcurrentServerChange({ clientEntries, mergedEntries: clientEntries })).toBe(false);
  });

  it('is false when the server only adds history from before the client\'s branch point', () => {
    const clientEntries = [entry(AuditEntryType.Branched, 2), entry(AuditEntryType.Updated, 3)];
    const mergedEntries = [entry(AuditEntryType.Created, 1), entry(AuditEntryType.Updated, 2), entry(AuditEntryType.Updated, 3)];

    expect(hasConcurrentServerChange({ clientEntries, mergedEntries })).toBe(false);
  });

  it('is true when the server holds a change made after the client\'s branch point that the client never saw', () => {
    const clientEntries = [entry(AuditEntryType.Branched, 1), entry(AuditEntryType.Updated, 3)];
    const mergedEntries = [entry(AuditEntryType.Created, 1), entry(AuditEntryType.Updated, 2), entry(AuditEntryType.Updated, 3)];

    expect(hasConcurrentServerChange({ clientEntries, mergedEntries })).toBe(true);
  });

  it('is true for a client with no branch point when the server already holds another change', () => {
    const clientEntries = [entry(AuditEntryType.Created, 1), entry(AuditEntryType.Updated, 3)];
    const mergedEntries = [entry(AuditEntryType.Created, 1), entry(AuditEntryType.Updated, 2), entry(AuditEntryType.Updated, 3)];

    expect(hasConcurrentServerChange({ clientEntries, mergedEntries })).toBe(true);
  });

  it('ignores branch markers the client did not send', () => {
    const clientEntries = [entry(AuditEntryType.Branched, 1), entry(AuditEntryType.Updated, 3)];
    const mergedEntries = [entry(AuditEntryType.Created, 1), entry(AuditEntryType.Branched, 2), entry(AuditEntryType.Updated, 3)];

    expect(hasConcurrentServerChange({ clientEntries, mergedEntries })).toBe(false);
  });
});
