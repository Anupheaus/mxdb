// Server-only setup for `auditReset.crud.e2e.tests.ts`. Imported by the forked e2e server (via
// `setupE2E({ serverExtensionsModule })`) before it starts — never by the test worker.

import { createServerActionHandler } from '@anupheaus/nexus/server';
import { useCollection, type ServerConfig } from '../../../src/server/index.js';
import { e2eTestCollection } from '../setup/types.js';
import { resetRecordAuditAction } from './auditReset.fixture.js';

const resetRecordAudit = createServerActionHandler(resetRecordAuditAction, async ({ record }) => {
  await useCollection(e2eTestCollection).upsert(record, { resetAudit: true });
});

/** The synchronised collection plus the server's own audit-resetting write. */
export const serverConfig: Partial<ServerConfig> = {
  collections: [e2eTestCollection],
  actions: [resetRecordAudit],
};
