// Shared by `auditReset.crud.e2e.tests.ts` and the server extensions it loads into the forked server.

import { defineAction } from '@anupheaus/nexus/common';
import type { E2eTestRecord } from '../setup/types.js';

/**
 * The server's own rewrite of a record with its audit reset, as an application's anonymisation does: the record is
 * replaced by `record` and its audit becomes a single `Created` entry holding it (`upsert(record, { resetAudit: true })`).
 */
export const resetRecordAuditAction = defineAction<{ record: E2eTestRecord }, void>()('e2eResetRecordAuditAction');
