import { AsyncLocalStorage } from 'node:async_hooks';
import type { Record } from '@anupheaus/common';
import type { MXDBCollection } from '../../common';
import { getCollectionExtensions, type MXDBWriteLock } from './extendCollection';

/** One hold of a write lock taken here; flagged released so work that outlives the write cannot re-enter. */
interface WriteLockHold {
  lock: MXDBWriteLock;
  isReleased: boolean;
}

/** The write locks the current piece of work holds through mxdb (its own takes, not the app's). */
const heldWriteLocks = new AsyncLocalStorage<readonly WriteLockHold[]>();

function isHeld(lock: MXDBWriteLock): boolean {
  return heldWriteLocks.getStore()?.some(hold => hold.lock === lock && !hold.isReleased) === true;
}

/**
 * Runs `task` — a write's before-write check and its save — holding the collection's `writeLock`, so no other write
 * that takes the same lock can land in between. A collection without a lock runs `task` as it is.
 *
 * Re-entrant: work that already holds the lock through mxdb (a hook writing to another collection that shares it)
 * runs straight away instead of waiting on itself. The hold ends when `task` settles; work it left running after that
 * queues like anyone else.
 */
export async function runInWriteLock<RecordType extends Record, T>(collection: MXDBCollection<RecordType>, task: () => Promise<T>): Promise<T> {
  const lock = getCollectionExtensions(collection)?.writeLock;
  if (lock == null || isHeld(lock)) return task();
  return lock(async () => {
    const hold: WriteLockHold = { lock, isReleased: false };
    try {
      return await heldWriteLocks.run([...heldWriteLocks.getStore() ?? [], hold], task);
    } finally {
      hold.isReleased = true;
    }
  });
}
