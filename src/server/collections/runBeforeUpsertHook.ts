import type { Record } from '@anupheaus/common';
import type { MXDBCollection } from '../../common';
import { getCollectionExtensions } from './extendCollection';

export interface RunBeforeUpsertHookProps<RecordType extends Record> {
  collection: MXDBCollection<RecordType>;
  /** The records about to be written. */
  records: RecordType[];
  /** The currently stored versions of those records; a record with no stored version is an insert. */
  existingRecords: RecordType[];
}

/**
 * Runs the collection's `onBeforeUpsert` hook (if one is registered) for records about to be written, and
 * returns the records that should actually be written.
 *
 * The hook receives copies, so it may amend them in place (e.g. clear derived fields) without mutating the
 * caller's objects; the returned copies carry those amendments. When no hook is registered the given
 * records are returned untouched. A hook that throws rejects the write — nothing should be persisted.
 */
export async function runBeforeUpsertHook<RecordType extends Record>({
  collection,
  records,
  existingRecords,
}: RunBeforeUpsertHookProps<RecordType>): Promise<RecordType[]> {
  const onBeforeUpsert = getCollectionExtensions(collection)?.onBeforeUpsert;
  if (onBeforeUpsert == null || records.length === 0) return records;

  const existingIds = new Set(existingRecords.ids());
  const recordsToWrite = records.map(record => Object.clone(record));
  const recordIds = recordsToWrite.ids();
  await onBeforeUpsert({
    records: recordsToWrite,
    insertedIds: recordIds.filter(id => !existingIds.has(id)),
    updatedIds: recordIds.filter(id => existingIds.has(id)),
  });
  return recordsToWrite;
}
