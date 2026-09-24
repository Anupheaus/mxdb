import { fileURLToPath } from 'url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditor } from '../../../src/common';
import type { E2eTestRecord } from '../setup/types';
import { resetE2E, setupE2E, teardownE2E, useClient, useServer, waitUntilAsync } from '../setup';
import { getServerAudit, newRecordId } from './utils';
import {
  AMEND_ON_UPSERT_VALUE,
  AMENDED_BY_SERVER_VALUE,
  NOTIFY_ON_DELETE_TAG_PREFIX,
  deletedNotice,
} from './beforeHooks.constants';

/**
 * Collection before-write hooks on writes that arrive from a synced client (the server registers the hooks
 * in `beforeHooks.serverExtensions.ts`): `onBeforeUpsert` amends a record before it is persisted and the
 * client that wrote it converges to the amended record; `onBeforeDelete` can read the record being deleted.
 */
describe('e2e collection before-write hooks on synced client writes', () => {
  beforeAll(async () => {
    await setupE2E({ serverExtensionsModule: fileURLToPath(new URL('./beforeHooks.serverExtensions.ts', import.meta.url)) });
  }, 90_000);

  beforeEach(async () => {
    await resetE2E();
  });

  afterAll(async () => {
    await teardownE2E();
  }, 30_000);

  async function serverRecord(id: string): Promise<E2eTestRecord | undefined> {
    return (await useServer().readLiveRecords()).find(record => record.id === id);
  }

  async function waitForServerValue(id: string, value: string): Promise<void> {
    await waitUntilAsync(async () => (await serverRecord(id))?.value === value, `server record "${id}" has value "${value}"`, 30_000);
  }

  async function waitForClientValue(client: ReturnType<typeof useClient>, id: string, value: string): Promise<void> {
    await waitUntilAsync(async () => (await client.getLocalRecord(id))?.value === value, `client record "${id}" has value "${value}"`, 30_000);
  }

  const amendingWrites: Array<[string, (id: string) => E2eTestRecord[]]> = [
    ['creates', id => [{ id, clientId: 'a', value: AMEND_ON_UPSERT_VALUE }]],
    ['updates', id => [{ id, clientId: 'a', value: 'plain' }, { id, clientId: 'a', value: AMEND_ON_UPSERT_VALUE }]],
  ];

  it.each(amendingWrites)('persists the hook-amended record when a client %s it', async (_label, writesFor) => {
    const a = useClient('a');
    await a.connect();
    const id = newRecordId('e2e-before-upsert');

    for (const record of writesFor(id)) await a.upsert(record);

    await waitForServerValue(id, AMENDED_BY_SERVER_VALUE);
    expect(auditor.createRecordFrom(await getServerAudit(id))?.value).toBe(AMENDED_BY_SERVER_VALUE);
  }, 120_000);

  it.each(amendingWrites)('brings the client that %s a record round to the hook-amended record', async (_label, writesFor) => {
    const a = useClient('a');
    await a.connect();
    const id = newRecordId('e2e-before-upsert-client');

    for (const record of writesFor(id)) await a.upsert(record);

    await waitForClientValue(a, id, AMENDED_BY_SERVER_VALUE);
  }, 120_000);

  it('lets onBeforeDelete read the record a client deletes', async () => {
    const a = useClient('a');
    await a.connect();
    const notifiedId = newRecordId('e2e-before-delete-notified');
    const deletedId = newRecordId('e2e-before-delete-deleted');
    await a.upsert({ id: notifiedId, clientId: 'a', value: 'waiting' });
    await a.upsert({ id: deletedId, clientId: 'a', name: 'doomed', tags: [`${NOTIFY_ON_DELETE_TAG_PREFIX}${notifiedId}`] });
    await useServer().waitForLiveRecord(notifiedId);
    await useServer().waitForLiveRecord(deletedId);

    await a.remove(deletedId);

    await waitForServerValue(notifiedId, deletedNotice('doomed'));
  }, 120_000);
});
