import type { Logger, Record } from '@anupheaus/common';
import { AuditEntryType, type AuditEntry, type ServerAuditUpdateEntry } from '../../../common';
import { recordDiff } from '../../../common/auditor/diff';
import { replayHistoryEndState } from '../../../common/auditor/replay';
import { MXDB_DIRECT_WRITE_USER_ID } from '../../audit/directWriteUserId';
import { dbUtils } from './db-transforms';

export interface DirectWriteEntryRequest<RecordType extends Record> {
  /** The record's history as the server holds it. */
  entries: AuditEntry<RecordType>[];
  /** The record as it is stored now. */
  storedRecord: RecordType;
  /** Mints the new entry's id, given the id of the newest entry in the history. */
  generateEntryId(lastEntryId: string): string;
  logger?: Logger;
}

/**
 * The entry a record's history is missing when the record was changed without mxdb (a fix by hand, a migration), or
 * `undefined` when the history already ends in the stored record.
 *
 * The record a later edit is laid over is rebuilt from its history (sc-5449), so a change the history never saw would be
 * undone by the next edit made in the app or on a device. The returned `Updated` entry holds exactly what the change did
 * (the difference between the record the history rebuilds and the stored one), attributed to
 * {@link MXDB_DIRECT_WRITE_USER_ID}. Only a live history is judged: a record with no history has nothing to be missing from
 * (the receiver anchors its first edit on the stored record), and a deleted one stays deleted.
 */
export function directWriteEntryFor<RecordType extends Record>({ entries, storedRecord, generateEntryId, logger }: DirectWriteEntryRequest<RecordType>): ServerAuditUpdateEntry | undefined {
  if (entries.length === 0) return;
  const { live } = replayHistoryEndState(entries, undefined, logger);
  if (live == null) return;
  // Compared as stored, so a difference only in how the two were made (an `undefined` the driver stores as `null`) is none.
  const ops = recordDiff(dbUtils.asStored(live), storedRecord);
  if (ops.length === 0) return;
  const lastEntryId = entries.reduce((latest, { id }) => (id > latest ? id : latest), '');
  return { type: AuditEntryType.Updated, id: generateEntryId(lastEntryId), ops, userId: MXDB_DIRECT_WRITE_USER_ID };
}
