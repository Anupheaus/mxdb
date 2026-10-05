// Shared by `readGateContext.crud.e2e.tests.ts` and the server extensions it loads into the forked server.

/** Every connection is routed to this database, not the server's default one: the read gate must read it. */
export const TENANT_DB_NAME = 'mxdb-e2e-tenant';

/** The record listing who may read the collection, by user id (its `tags`). It exists only in the tenant database. */
export const ACCESS_LIST_RECORD_ID = 'read-gate-access-list';

/** An id no record carries, so a gate filter on it matches nothing. */
export const NO_MATCH_ID = 'read-gate-no-match';

/** Where the server keeps sign-in sessions (`AuthCollection`). */
export const AUTH_COLLECTION_NAME = 'mxdb_authentication';
