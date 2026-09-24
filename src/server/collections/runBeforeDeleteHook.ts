import type { Record } from '@anupheaus/common';
import type { MXDBCollection } from '../../common';
import { getCollectionExtensions } from './extendCollection';

export interface RunBeforeDeleteHookProps<RecordType extends Record> {
  collection: MXDBCollection<RecordType>;
  /** The ids about to be deleted. */
  recordIds: string[];
  /**
   * Resolves which of `recordIds` are currently stored. Only called when a hook is registered, so
   * collections without one pay no extra read.
   */
  getStoredIds(recordIds: string[]): Promise<string[]>;
}

/**
 * Runs the collection's `onBeforeDelete` hook (if one is registered) before records are deleted, while
 * they are still stored, so the hook can read them and clean up anything that references them.
 *
 * The hook only fires for ids that are actually stored: deleting a record that does not exist (or was
 * already deleted) is not a write, so it must not fire the hook again. A hook that throws rejects the
 * delete — nothing should be removed.
 */
export async function runBeforeDeleteHook<RecordType extends Record>({
  collection,
  recordIds,
  getStoredIds,
}: RunBeforeDeleteHookProps<RecordType>): Promise<void> {
  const onBeforeDelete = getCollectionExtensions(collection)?.onBeforeDelete;
  if (onBeforeDelete == null || recordIds.length === 0) return;

  const storedIds = new Set(await getStoredIds(recordIds));
  const deletingIds = recordIds.filter(id => storedIds.has(id));
  if (deletingIds.length === 0) return;
  await onBeforeDelete({ recordIds: deletingIds });
}
