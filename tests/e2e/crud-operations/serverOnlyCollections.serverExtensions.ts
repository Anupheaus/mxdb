// Server-only setup for `serverOnlyCollections.crud.e2e.tests.ts`. Imported by the forked e2e server (via
// `setupE2E({ serverExtensionsModule })`) before it starts — never by the test worker.

import type { DataFilters } from '@anupheaus/common';
import { createServerActionHandler } from '@anupheaus/nexus/server';
import { extendCollection, useCollection, type ServerConfig } from '../../../src/server/index.js';
import type { QueryProps } from '../../../src/common/index.js';
import { e2eTestCollection, type E2eTestRecord } from '../setup/types.js';
import { GATED_VALUE, serverOnlyProbeAction, serverOnlySecretsCollection } from './serverOnlyCollections.fixture.js';

const serverOnlyProbe = createServerActionHandler(serverOnlyProbeAction, async ({ upsert }) => {
  const secrets = useCollection(serverOnlySecretsCollection);
  if (upsert != null) await secrets.upsert(upsert);
  return secrets.getAll();
});

/** The server registers the server-only collection beside the synchronised one, and its own probe action. */
export const serverConfig: Partial<ServerConfig> = {
  collections: [e2eTestCollection, serverOnlySecretsCollection],
  actions: [serverOnlyProbe],
};

// A read gate on the synchronised collection, so the suite can show the gates still apply there: no client reads a
// record carrying GATED_VALUE.
extendCollection(e2eTestCollection, {
  onQuery({ request }): QueryProps<E2eTestRecord> {
    const { filters } = request as QueryProps<E2eTestRecord>;
    const gate: DataFilters<E2eTestRecord> = { value: { $ne: GATED_VALUE } };
    return { ...request, filters: filters == null ? gate : { $and: [filters, gate] } } as QueryProps<E2eTestRecord>;
  },
});
