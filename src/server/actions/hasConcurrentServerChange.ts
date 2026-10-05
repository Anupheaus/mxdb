import { AuditEntryType, type AuditEntry } from '../../common/auditor';

export interface HasConcurrentServerChangeProps {
  /** The entries the client sent for the record, including its `Branched` anchor when it has one. */
  clientEntries: AuditEntry[];
  /** The server audit merged with the client's entries, before any before-write hook amends it. */
  mergedEntries: AuditEntry[];
}

/**
 * Whether a client's change was merged with a change it had not seen: the server holds an entry the client did
 * not send that is newer than the client's last sync point (its latest `Branched` anchor). Used to count
 * conflicts in the C2S write summary; conflicts are still resolved by ULID order, this only reports them.
 *
 * ULIDs sort lexicographically by time, so a plain string compare orders them.
 */
export function hasConcurrentServerChange({ clientEntries, mergedEntries }: HasConcurrentServerChangeProps): boolean {
  const sentIds = new Set(clientEntries.map(({ id }) => id));
  // No anchor means the client has never synced this record, so every server change is one it has not seen.
  const anchorId = clientEntries.reduce((latest, { type, id }) => (type === AuditEntryType.Branched && id > latest ? id : latest), '');
  return mergedEntries.some(({ type, id }) => type !== AuditEntryType.Branched && id > anchorId && !sentIds.has(id));
}
