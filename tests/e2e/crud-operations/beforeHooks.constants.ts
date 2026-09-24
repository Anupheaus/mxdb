/**
 * Markers shared by `beforeHooks.serverExtensions.ts` (runs in the forked server) and
 * `beforeHooks.crud.e2e.tests.ts` (runs in the test worker). Kept in their own module so the test worker
 * never imports the server extension itself.
 */

/** A record written with this `value` is amended by the server's `onBeforeUpsert` hook… */
export const AMEND_ON_UPSERT_VALUE = 'amend-me';

/** …to this `value`, before it is persisted. */
export const AMENDED_BY_SERVER_VALUE = 'amended-by-server';

/**
 * Deleting a record tagged `${NOTIFY_ON_DELETE_TAG_PREFIX}<id>` makes the server's `onBeforeDelete` hook
 * read the record being deleted and stamp record `<id>` with {@link deletedNotice} of its name.
 */
export const NOTIFY_ON_DELETE_TAG_PREFIX = 'notify-on-delete:';

/** The `value` the `onBeforeDelete` hook writes onto the notified record. */
export function deletedNotice(deletedRecordName: string | null | undefined): string {
  return `deleted:${deletedRecordName ?? ''}`;
}
