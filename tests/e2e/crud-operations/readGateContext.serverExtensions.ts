// Server-only setup for `readGateContext.crud.e2e.tests.ts`. Imported by the forked e2e server (via
// `setupE2E({ serverExtensionsModule })`) before it starts — never by the test worker.

import type { DataFilters } from '@anupheaus/common';
import { extendCollection, useCollection, type ServerConfig } from '../../../src/server/index.js';
import type { QueryProps } from '../../../src/common/index.js';
import { e2eTestCollection, type E2eTestRecord } from '../setup/types.js';
import { E2E_SERVER_PROCESS_ENV } from '../setup/mongoConstants.js';
import { ACCESS_LIST_RECORD_ID, NO_MATCH_ID, TENANT_DB_NAME } from './readGateContext.constants.js';

const mongoDbUrl = process.env[E2E_SERVER_PROCESS_ENV.MONGO_URI] ?? '';

/** Every connection (socket and REST, so sessions too) works in the tenant database. */
export const serverConfig: Partial<ServerConfig> = {
  resolveConnectionDb: async () => ({ dbName: TENANT_DB_NAME, mongoDbUrl }),
};

// The read gate, shaped like an app's role lookup: it reads the access list from the caller's database each time it
// runs. A gate run against the wrong database finds no list; one run as the wrong user finds the wrong answer.
extendCollection(e2eTestCollection, {
  async onQuery({ request, userId }): Promise<QueryProps<E2eTestRecord>> {
    const accessList = userId == null ? undefined : await useCollection(e2eTestCollection).get(ACCESS_LIST_RECORD_ID);
    const isAllowed = userId != null && accessList?.tags?.includes(userId) === true;
    if (isAllowed) return request as QueryProps<E2eTestRecord>;
    const { filters } = request as QueryProps<E2eTestRecord>;
    const gate: DataFilters<E2eTestRecord> = { id: NO_MATCH_ID };
    return { ...request, filters: filters == null ? gate : { $and: [filters, gate] } } as QueryProps<E2eTestRecord>;
  },
});
