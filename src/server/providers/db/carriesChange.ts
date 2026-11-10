import { AuditEntryType, type AuditEntry } from '../../../common';

/**
 * Whether an audit entry changes anything when replayed: not a `Branched` anchor and not an `Updated` with no ops (what a
 * device sends for "the same value again"). Only such an entry can be a late change worth keeping in the history (sc-5471):
 * an entry's id is stamped by the device's own clock, so one from a device whose clock runs behind sorts before the
 * server's newest entry even when it is new.
 */
export function carriesChange(entry: AuditEntry): boolean {
  if (entry.type === AuditEntryType.Branched) return false;
  if (entry.type === AuditEntryType.Updated) return Array.isArray(entry.ops) && entry.ops.length > 0;
  return true;
}
