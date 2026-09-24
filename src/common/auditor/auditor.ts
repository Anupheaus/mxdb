import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import { hashRecord } from './hash';
import { generateUlid, generateUlidAfter, setClockDrift } from './time';
import type { AnyAuditOf, AuditOf } from './auditor-models';
import {
  collapseToAnchor,
  createAuditFrom,
  createBranchFrom,
  createRecordFrom,
  deleteRecord,
  entriesOf,
  filterValidEntries,
  getBranchUlid,
  getLastEntryId,
  getLastEntryTimestamp,
  hasHistory,
  hasPendingChanges,
  isAudit,
  isAuditDocument,
  isBranchOnly,
  isDeleted,
  merge,
  rebaseRecord,
  restoreTo,
  updateAuditWith,
  type UlidGenerator,
} from './api';

const ulidGenerator: UlidGenerator = () => generateUlid();

export { setClockDrift, hashRecord };

export const auditor = {
  createAuditFrom: <T extends MXDBRecord>(record: T) =>
    createAuditFrom(record, ulidGenerator),
  updateAuditWith: <T extends MXDBRecord>(
    currentRecord: T | undefined,
    audit: AuditOf<T>,
    baseRecord?: T,
    logger?: Logger,
  ) =>
    updateAuditWith(
      currentRecord,
      audit,
      ulidGenerator,
      baseRecord,
      logger,
    ),
  /**
   * {@link updateAuditWith}, but the new entry is guaranteed to sort after every existing entry — for
   * server-authored entries appended to a client-supplied audit, whose ids may come from a clock that
   * runs ahead (see {@link generateUlidAfter}).
   */
  updateAuditWithAfterLatest: <T extends MXDBRecord>(
    currentRecord: T | undefined,
    audit: AuditOf<T>,
    baseRecord?: T,
    logger?: Logger,
  ) =>
    updateAuditWith(currentRecord, audit, () => generateUlidAfter(getLastEntryId(audit)), baseRecord, logger),
  /** Appends a Deleted entry guaranteed to sort after every existing entry (see {@link generateUlidAfter}). */
  deleteAfterLatest: <T extends MXDBRecord>(audit: AnyAuditOf<T>) =>
    deleteRecord(audit, () => generateUlidAfter(getLastEntryId(audit))),
  createRecordFrom,
  filterValidEntries,
  entriesOf,
  isAuditDocument,
  collapseToAnchor,
  createBranchFrom,
  merge,
  restoreTo: <T extends MXDBRecord>(audit: AnyAuditOf<T>, record: T, baseRecord?: T, logger?: Logger) =>
    restoreTo(audit, record, ulidGenerator, baseRecord, logger),
  delete: <T extends MXDBRecord>(audit: AnyAuditOf<T>) =>
    deleteRecord(audit, ulidGenerator),
  rebaseRecord,
  hasHistory,
  hasPendingChanges,
  isDeleted,
  isBranchOnly,
  isAudit: <T extends MXDBRecord>(value: unknown, fullAudit: boolean, logger?: Logger) =>
    isAudit<T>(value, fullAudit, logger),
  getBranchUlid,
  getLastEntryId,
  getLastEntryTimestamp,
  hashRecord,
  generateUlid,
  generateUlidAfter,
  setClockDrift,
};
