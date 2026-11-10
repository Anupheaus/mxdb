import { AuditEntryType, type AuditEntry } from '../auditor/auditor-models';

/**
 * A client's audit entry with only the fields a client may set, by entry type: its `id` and `type`, a `Created`'s
 * `record`, an `Updated`'s `ops` and a `Restored`'s `record`. Everything else is the server's alone and is dropped:
 *
 * - `userId`: who an entry is attributed to. The server stamps the signed-in sender on every entry it does not already
 *   hold, so a client can never pass its own change off as another user's, the server's own (`__mxdb_system__`) or a
 *   change made outside the app (`__mxdb_direct_write__`, sc-5449). An entry the server already holds keeps the stored
 *   attribution (the merge keeps the server's copy).
 * - `reset` and `compaction` on a `Created`: only the server starts a history again or folds one (sc-4321, sc-4409).
 * - a `Deleted` entry's `record` snapshot: the server attaches it from what it held.
 *
 * A whitelist, so any server-only field added later is dropped too.
 */
export function asClientEntry(entry: AuditEntry): AuditEntry {
  const { id, type } = entry;
  switch (type) {
    case AuditEntryType.Created: return { id, type, record: entry.record };
    case AuditEntryType.Updated: return { id, type, ops: entry.ops };
    case AuditEntryType.Restored: return entry.record === undefined ? { id, type } : { id, type, record: entry.record };
    default: return { id, type } as AuditEntry;
  }
}
