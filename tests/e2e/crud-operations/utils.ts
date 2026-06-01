import { decodeTime } from 'ulidx';
import { expect } from 'vitest';
import type {
  AuditEntry
} from '../../../src/common';
import {
  AuditEntryType,
  entriesOf,
  type AuditOf,
  type ServerAuditDeletedEntry,
  type ServerAuditOf,
} from '../../../src/common';
import type { E2eTestRecord } from '../setup/types';
import type { E2EClientHandle } from '../setup';
import { useServer, waitUntilAsync } from '../setup';

export function newRecordId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function mainAuditTypes(types: AuditEntryType[]): AuditEntryType[] {
  return types.filter(
    t =>
      t === AuditEntryType.Created
      || t === AuditEntryType.Deleted
      || t === AuditEntryType.Updated
      || t === AuditEntryType.Restored,
  );
}

/** Server delete entries in chronological order (audit entry ULID time). */
export function serverDeletedEntriesOrdered(
  audit: ServerAuditOf<E2eTestRecord>,
): ServerAuditDeletedEntry<E2eTestRecord>[] {
  return (entriesOf(audit) as ServerAuditDeletedEntry<E2eTestRecord>[])
    .filter(e => e.type === AuditEntryType.Deleted)
    .sort((a, b) => decodeTime(a.id) - decodeTime(b.id));
}

/** Latest audit entry on a client audit (ULID time). */
export function getLastLocalAuditEntry(audit: AuditOf<E2eTestRecord> | undefined): AuditEntry<E2eTestRecord> | undefined {
  if (audit == null) return undefined;
  return entriesOf(audit).last();
}

export async function connectBoth(a: E2EClientHandle, b: E2EClientHandle): Promise<void> {
  await Promise.all([a.connect(), b.connect()]);
  await waitUntilAsync(
    async () => a.getIsConnected() && b.getIsConnected(),
    'both clients socket connected',
    30_000,
  );
}

/** A creates on server; B subscribes get-all and observes the row. */
export async function seedRowWithBOnGetAll(
  a: E2EClientHandle,
  b: E2EClientHandle,
  id: string,
): Promise<E2eTestRecord> {
  const created: E2eTestRecord = {
    id,
    clientId: 'a',
    value: 'created-by-a',
  };
  await connectBoth(a, b);
  await a.upsert(created);
  await useServer().waitForLiveRecord(id);
  await b.subscribeGetAll();
  await waitUntilAsync(
    async () => b.getGetAllSubscriptionSnapshot().some(r => r.id === id),
    'B getAll snapshot has seeded record',
    30_000,
  );
  return created;
}

export async function getServerAudit(id: string): Promise<ServerAuditOf<E2eTestRecord>> {
  const audit = (await useServer().readAudits()).get(id);
  if (audit == null) throw new Error(`Server audit for record "${id}" not found`);
  return audit;
}

/**
 * After {@link waitForAllClientsIdle}: no materialised row and no local audit document for each id on every client.
 */
export async function expectNoLocalRowOrAuditOnClients(
  clients: readonly E2EClientHandle[],
  recordIds: readonly string[],
): Promise<void> {
  for (const client of clients) {
    for (const id of recordIds) {
      expect(await client.getLocalRecord(id)).toBeUndefined();
      expect(await client.getLocalAudit(id)).toBeUndefined();
    }
  }
}