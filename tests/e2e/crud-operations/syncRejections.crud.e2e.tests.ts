import { fileURLToPath } from 'url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { E2eTestRecord } from '../setup/types';
import { e2eTestCollection } from '../setup/types';
import { resetE2E, setupE2E, teardownE2E, useClient, useServer, waitForAllClientsIdle, waitUntilAsync } from '../setup';
import { getServerAudit, newRecordId } from './utils';
import {
  DELETE_REJECTION_REASON,
  REJECT_ON_UPSERT_VALUE,
  UNDELETABLE_NAME,
  UPSERT_REJECTION_REASON,
} from './beforeHooks.constants';

/**
 * Reject and revert: when a collection before-write hook throws for a record a client synced, the server
 * refuses only that record, brings the device back in line (reverting an update, dropping a create; a
 * rejected delete stays deleted on the device) and tells the app why — and the client does not keep
 * resending it. The rejecting hooks live in `beforeHooks.serverExtensions.ts`.
 */
describe('e2e sync rejections by before-write hooks', () => {
  beforeAll(async () => {
    await setupE2E({ serverExtensionsModule: fileURLToPath(new URL('./beforeHooks.serverExtensions.ts', import.meta.url)) });
  }, 90_000);

  beforeEach(async () => {
    await resetE2E();
  });

  afterAll(async () => {
    await teardownE2E();
  }, 30_000);

  type Client = ReturnType<typeof useClient>;

  async function serverRecord(id: string): Promise<E2eTestRecord | undefined> {
    return (await useServer().readLiveRecords()).find(record => record.id === id);
  }

  async function connectedClient(): Promise<Client> {
    const client = useClient('a');
    await client.connect();
    return client;
  }

  async function createOnServer(client: Client, record: E2eTestRecord): Promise<void> {
    await client.upsert(record);
    await useServer().waitForLiveRecord(record.id);
    await waitForAllClientsIdle([client]);
  }

  async function waitForClientValue(client: Client, id: string, value: string): Promise<void> {
    await waitUntilAsync(async () => (await client.getLocalRecord(id))?.value === value, `client record "${id}" has value "${value}"`, 30_000);
  }

  async function waitForRejection(client: Client, recordId: string): Promise<void> {
    await waitUntilAsync(async () => client.getSyncRejections().some(rejection => rejection.recordId === recordId), `client told "${recordId}" was rejected`, 30_000);
  }

  describe('a rejected update', () => {
    async function rejectUpdate(): Promise<{ client: Client; id: string }> {
      const client = await connectedClient();
      const id = newRecordId('e2e-reject-update');
      await createOnServer(client, { id, clientId: 'a', value: 'original' });
      await client.upsert({ id, clientId: 'a', value: REJECT_ON_UPSERT_VALUE });
      return { client, id };
    }

    it('is reverted on the device to the server\'s version', async () => {
      const { client, id } = await rejectUpdate();

      await waitForClientValue(client, id, 'original');

      expect((await serverRecord(id))?.value).toBe('original');
    }, 120_000);

    it('is reported to the app with the hook\'s reason', async () => {
      const { client, id } = await rejectUpdate();

      await waitForRejection(client, id);

      expect(client.getSyncRejections()).toEqual([{ collectionName: e2eTestCollection.name, recordId: id, reason: UPSERT_REJECTION_REASON }]);
    }, 120_000);

    it('is not resent once reverted', async () => {
      const { client, id } = await rejectUpdate();
      await waitForClientValue(client, id, 'original');
      await waitForAllClientsIdle([client]);
      const settledAuditLength = (await getServerAudit(id)).entries.length;

      await waitForAllClientsIdle([client], { stableTicksRequired: 30 });

      expect([(await getServerAudit(id)).entries.length, client.getSyncRejections().length, client.getPendingC2SSyncQueueSize()])
        .toEqual([settledAuditLength, 1, 0]);
    }, 120_000);
  });

  it('removes a rejected create from the device', async () => {
    const client = await connectedClient();
    const id = newRecordId('e2e-reject-create');

    await client.upsert({ id, clientId: 'a', value: REJECT_ON_UPSERT_VALUE });
    await waitForRejection(client, id);
    await waitUntilAsync(async () => (await client.getLocalRecord(id)) == null, `client dropped "${id}"`, 30_000);

    expect(await serverRecord(id)).toBeUndefined();
  }, 120_000);

  it('keeps a rejected delete on the server and tells the app why', async () => {
    const client = await connectedClient();
    const id = newRecordId('e2e-reject-delete');
    await createOnServer(client, { id, clientId: 'a', name: UNDELETABLE_NAME });

    await client.remove(id);
    await waitForRejection(client, id);

    expect([client.getSyncRejections(), (await serverRecord(id))?.name]).toEqual([
      [{ collectionName: e2eTestCollection.name, recordId: id, reason: DELETE_REJECTION_REASON }],
      UNDELETABLE_NAME,
    ]);
  }, 120_000);

  it('persists the other records synced alongside a rejected one', async () => {
    const client = await connectedClient();
    const rejectedId = newRecordId('e2e-reject-batch-rejected');
    const acceptedId = newRecordId('e2e-reject-batch-accepted');

    await Promise.all([
      client.upsert({ id: rejectedId, clientId: 'a', value: REJECT_ON_UPSERT_VALUE }),
      client.upsert({ id: acceptedId, clientId: 'a', value: 'accepted' }),
    ]);
    await useServer().waitForLiveRecord(acceptedId);
    await waitForRejection(client, rejectedId);

    expect([(await serverRecord(acceptedId))?.value, await serverRecord(rejectedId)]).toEqual(['accepted', undefined]);
  }, 120_000);
});
