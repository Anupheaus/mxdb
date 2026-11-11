/**
 * The user a server audit entry is attributed to when it records a change written to the record without mxdb (a fix by
 * hand in the database, a data migration): no one signed in to the app made it, so it is marked as made outside the app.
 */
export const MXDB_DIRECT_WRITE_USER_ID = '__mxdb_direct_write__';
