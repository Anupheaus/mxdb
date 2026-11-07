import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import { compactAuditEntries } from '../../common/auditor/compaction';
import type { ServerAuditCreatedEntry, ServerAuditEntry, ServerAuditOf } from '../../common';
import { MXDB_SYSTEM_USER_ID } from './systemUserId';

/**
 * Who a snapshot of folded entries is attributed to: the last person among them (so an application can still tell a record
 * a person changed from one only the server wrote), else whoever wrote the newest of them.
 */
function attributionOf(folded: ServerAuditEntry[]): string {
  const people = folded.filter(({ userId }) => userId !== MXDB_SYSTEM_USER_ID);
  const source = people[people.length - 1] ?? folded[folded.length - 1];
  return source?.userId ?? MXDB_SYSTEM_USER_ID;
}

/**
 * A server audit with its history kept bounded: once it outgrows the compaction limits, its oldest entries are folded into
 * one `Created` snapshot (see `compactAuditEntries`). Returns `audit` itself when there is nothing to fold.
 */
export function compactServerAudit<RecordType extends MXDBRecord>(audit: ServerAuditOf<RecordType>, logger?: Logger): ServerAuditOf<RecordType> {
  const result = compactAuditEntries(audit.entries, undefined, logger);
  if (result == null) return audit;
  const [snapshot, ...kept] = result.entries;
  const folded = result.folded as ServerAuditEntry<RecordType>[];
  const attributed = { ...snapshot, userId: attributionOf(folded) } as ServerAuditCreatedEntry<RecordType>;
  logger?.debug('[server audit] compacted', { recordId: audit.id, folded: folded.length, kept: kept.length });
  return { id: audit.id, entries: [attributed, ...(kept as ServerAuditEntry<RecordType>[])] };
}
