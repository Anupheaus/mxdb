// Server-only collection extensions for `beforeHooks.crud.e2e.tests.ts`. Imported by the forked e2e server
// (via `setupE2E({ serverExtensionsModule })`) before it starts — never by the test worker.

import { extendCollection, useCollection } from '../../../src/server/index.js';
import { e2eTestCollection } from '../setup/types.js';
import {
  AMEND_ON_UPSERT_VALUE,
  AMENDED_BY_SERVER_VALUE,
  DELETE_REJECTION_REASON,
  NOTIFY_ON_DELETE_TAG_PREFIX,
  REJECT_ON_UPSERT_VALUE,
  UNDELETABLE_NAME,
  UPSERT_REJECTION_REASON,
  deletedNotice,
} from './beforeHooks.constants.js';

extendCollection(e2eTestCollection, {
  onBeforeUpsert({ records }) {
    if (records.some(record => record.value === REJECT_ON_UPSERT_VALUE)) throw new Error(UPSERT_REJECTION_REASON);
    for (const record of records) {
      if (record.value === AMEND_ON_UPSERT_VALUE) record.value = AMENDED_BY_SERVER_VALUE;
    }
  },
  async onBeforeDelete({ recordIds }) {
    const { get, upsert } = useCollection(e2eTestCollection);
    const deletingRecords = await get(recordIds);
    if (deletingRecords.some(record => record.name === UNDELETABLE_NAME)) throw new Error(DELETE_REJECTION_REASON);
    for (const deletingRecord of deletingRecords) {
      const notifiedIds = (deletingRecord.tags ?? [])
        .filter(tag => tag.startsWith(NOTIFY_ON_DELETE_TAG_PREFIX))
        .map(tag => tag.slice(NOTIFY_ON_DELETE_TAG_PREFIX.length));
      const notifiedRecords = await get(notifiedIds);
      await upsert(notifiedRecords.map(notifiedRecord => ({ ...notifiedRecord, value: deletedNotice(deletingRecord.name) })));
    }
  },
});
