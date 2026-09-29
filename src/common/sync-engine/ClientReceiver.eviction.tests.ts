import { describe, it, expect, vi } from 'vitest';
import '@anupheaus/common'; // install Object.clone and other extensions
import type { Logger } from '@anupheaus/common';
import { auditor, type AuditOf } from '../auditor';
import { ClientReceiver, type MXDBRecordCursors, type MXDBRecordStates, type MXDBSyncEngineResponse, type MXDBUpdateRequest } from '.';

/**
 * An eviction is a server telling the client to drop a record it may no longer hold (sc-584). With nothing pending it is
 * applied like a delete (the provider removes the local copy); with local changes still to sync it is declined — the
 * changes must reach the server, which judges them, and the server forgets the record for this client either way.
 */

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() } as unknown as Logger;
const COLLECTION = 'items';
const record = { id: 'r1', name: 'Alice' };
const eviction: MXDBRecordCursors = [{ collectionName: COLLECTION, records: [{ recordId: 'r1', lastAuditEntryId: '', isEviction: true }] }];

/** Runs `cursors` through a receiver whose local store holds `record` with `audit`; returns what it applied and answered. */
function receive(localAudit: AuditOf<typeof record> | undefined) {
  const localStates: MXDBRecordStates = localAudit == null ? [] : [{ collectionName: COLLECTION, records: [{ record, audit: localAudit.entries }] }];
  const onUpdate = vi.fn((updates: MXDBUpdateRequest): MXDBSyncEngineResponse => updates.map(({ collectionName, deletedRecordIds, records }) => ({
    collectionName, successfulRecordIds: [...(deletedRecordIds ?? []), ...(records ?? []).map(({ record: { id } }) => id)],
  })));
  const onRetrieve = vi.fn(() => localStates) as unknown as ConstructorParameters<typeof ClientReceiver>[1]['onRetrieve'];
  const receiver = new ClientReceiver(logger, { onRetrieve, onUpdate });
  const response = receiver.process(eviction);
  return { applied: onUpdate.mock.calls[0]?.[0], response };
}

describe('ClientReceiver evictions', () => {
  it('drops a record with nothing pending, like a delete', () => {
    const synced = auditor.collapseToAnchor(auditor.createAuditFrom(record), auditor.generateUlid());
    const { applied, response } = receive(synced);
    expect(applied).toEqual([{ collectionName: COLLECTION, deletedRecordIds: ['r1'] }]);
    expect(response).toEqual([{ collectionName: COLLECTION, successfulRecordIds: ['r1'] }]);
  });

  it('declines while the record has local changes still to sync', () => {
    const synced = auditor.collapseToAnchor(auditor.createAuditFrom(record), auditor.generateUlid());
    const withLocalEdit = auditor.updateAuditWith({ ...record, name: 'Alicia' }, synced, record);
    const { applied, response } = receive(withLocalEdit);
    expect(applied).toBeUndefined();
    expect(response).toEqual([{ collectionName: COLLECTION, successfulRecordIds: [], declinedRecordIds: ['r1'] }]);
  });

  it('acknowledges a record it does not hold', () => {
    const { response } = receive(undefined);
    expect(response.find(({ collectionName }) => collectionName === COLLECTION)?.successfulRecordIds).toEqual(['r1']);
  });
});
