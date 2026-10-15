import { fileURLToPath } from 'url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditEntryType, entriesOf } from '../../../src/common';
import { resetE2E, setupE2E, teardownE2E, useClient, useServer, waitForAllClientsIdle, waitUntilAsync, type E2eTestRecord } from '../setup';
import { resetRecordAuditAction } from './auditReset.fixture';
import { newRecordId } from './utils';

/**
 * A server write with `resetAudit` (as an application's anonymisation makes, to clear the old snapshots of a record it has
 * stripped) reaches every synced client: the record is replaced in each device's SQLite, and no device's local `_audit`
 * keeps a value from before the reset. A device only ever holds a `Branched` anchor plus its own unsynced entries, and the
 * push carrying the reset moves that anchor past everything older.
 */

const ACTION_EVENT = 'nexus.actions';
const OLD_NAME = 'Casey Customer';
const OLD_VALUE = '12 Acacia Avenue';
const RESET: Pick<E2eTestRecord, 'name' | 'value'> = { name: 'Anonymised customer #1', value: 'Derby DE1' };

describe('e2e a server write that resets a record\'s audit', () => {
  beforeAll(async () => {
    await setupE2E({ serverExtensionsModule: fileURLToPath(new URL('./auditReset.serverExtensions.ts', import.meta.url)) });
  }, 90_000);

  beforeEach(async () => {
    await resetE2E();
  });

  afterAll(async () => {
    await teardownE2E();
  }, 30_000);

  async function resetOnServer(record: E2eTestRecord): Promise<void> {
    const answer = await useClient('a').sendRawRequest(`${ACTION_EVENT}.${resetRecordAuditAction.name}`, { record }) as { error?: unknown } | undefined;
    if (answer?.error != null) throw new Error(`The reset failed: ${JSON.stringify(answer.error)}`);
  }

  /** The server's audit is one `Created` entry holding the reset record. */
  async function expectServerAuditReset(id: string, record: E2eTestRecord): Promise<void> {
    await waitUntilAsync(async () => {
      const audit = (await useServer().readAudits()).get(id);
      const entries = audit == null ? [] : entriesOf(audit);
      return entries.length === 1 && entries[0]!.type === AuditEntryType.Created;
    }, 'server audit reset to one Created entry', 20_000);
    const audit = (await useServer().readAudits()).get(id)!;
    expect(JSON.stringify(audit)).not.toContain(OLD_NAME);
    expect(JSON.stringify(audit)).not.toContain(OLD_VALUE);
    expect((entriesOf(audit)[0] as { record: E2eTestRecord }).record).toMatchObject(record);
  }

  it('replaces the record on every synced device and leaves no old value in any device\'s local audit', async () => {
    const a = useClient('a');
    const b = useClient('b');
    await Promise.all([a.connect(), b.connect()]);
    await b.subscribeGetAll();

    const id = newRecordId('audit-reset');
    const created: E2eTestRecord = { id, clientId: 'a', name: OLD_NAME, value: 'first address' };
    await a.upsert(created);
    await a.upsert({ ...created, value: OLD_VALUE });
    await waitUntilAsync(async () => (await b.getLocalRecord(id))?.value === OLD_VALUE, 'b holds the edited record', 30_000);
    await waitForAllClientsIdle([a, b]);
    // Before the reset the server's audit holds the old snapshot and the edit.
    expect(JSON.stringify((await useServer().readAudits()).get(id))).toContain(OLD_NAME);

    const reset: E2eTestRecord = { ...created, ...RESET };
    await resetOnServer(reset);
    await expectServerAuditReset(id, reset);

    for (const client of [a, b]) {
      await waitUntilAsync(async () => (await client.getLocalRecord(id))?.name === RESET.name, 'the device holds the reset record', 30_000);
    }
    await waitForAllClientsIdle([a, b]);
    for (const client of [a, b]) {
      const localAudit = JSON.stringify(await client.getLocalAudit(id));
      expect(localAudit).not.toContain(OLD_NAME);
      expect(localAudit).not.toContain(OLD_VALUE);
      expect(await client.getLocalRecord(id)).toMatchObject(reset);
    }
  });

  it('keeps the reset when a device that was offline comes back with an older edit of the record', async () => {
    const a = useClient('a');
    const b = useClient('b');
    await Promise.all([a.connect(), b.connect()]);
    await b.subscribeGetAll();

    const id = newRecordId('audit-reset-offline');
    const created: E2eTestRecord = { id, clientId: 'a', name: 'Before', value: 'first address' };
    await a.upsert(created);
    await waitUntilAsync(async () => (await b.getLocalRecord(id)) != null, 'b holds the record', 30_000);
    await waitForAllClientsIdle([a, b]);

    // b edits while offline, before the server resets the record, so its unsynced entry is older than the reset.
    await b.disconnect();
    await b.upsert({ ...created, clientId: 'b', name: OLD_NAME, value: OLD_VALUE });

    const reset: E2eTestRecord = { ...created, ...RESET };
    await resetOnServer(reset);
    await expectServerAuditReset(id, reset);

    await b.reconnect();
    await waitForAllClientsIdle([a, b]);
    await waitUntilAsync(async () => (await b.getLocalRecord(id))?.name === RESET.name, 'b holds the reset record', 30_000);

    // The device's older edit does not bring the old values back into the server's audit, nor stay in its own.
    const serverAudit = JSON.stringify((await useServer().readAudits()).get(id));
    expect(serverAudit).not.toContain(OLD_NAME);
    expect(serverAudit).not.toContain(OLD_VALUE);
    for (const client of [a, b]) {
      const localAudit = JSON.stringify(await client.getLocalAudit(id));
      expect(localAudit).not.toContain(OLD_NAME);
      expect(localAudit).not.toContain(OLD_VALUE);
    }
  });
});
