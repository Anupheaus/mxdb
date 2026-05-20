import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@anupheaus/common'; // ensure Object.clone and other extensions are installed
import type { Logger } from '@anupheaus/common';
import { auditor, AuditEntryType } from '../auditor';
import {
  ServerReceiver,
  ServerDispatcher,
  type MXDBRecordStates,
  type MXDBRecordCursors,
  type ClientDispatcherRequest,
} from '.';

vi.mock('../auditor/hash', () => ({
  hashRecord: (record: any) => Promise.resolve(`mock-hash-${record.id}`),
  deterministicJson: (v: any) => JSON.stringify(v),
  contentHash: (v: any) => `content-${JSON.stringify(v)}`,
}));

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  silly: vi.fn(),
} as unknown as Logger;

function makeRecord(id: string, name: string) {
  return { id, name };
}

describe('ServerReceiver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeSD() {
    // onDispatch returns success for all records in the payload to prevent infinite retry loops
    const onDispatch = vi.fn().mockImplementation(async (payload: any) => {
      return payload.map((col: any) => ({
        collectionName: col.collectionName,
        successfulRecordIds: col.records.map((r: any) => r.record?.id ?? r.recordId),
      }));
    });
    const sd = new ServerDispatcher(mockLogger, { onDispatch });
    return { sd, onDispatch };
  }

  it('SD is operational after process completes (not left paused)', async () => {
    const { sd, onDispatch } = makeSD();

    const onRetrieve = vi.fn().mockResolvedValue([]);
    const onUpdate = vi.fn().mockResolvedValue([]);
    const sr = new ServerReceiver(mockLogger, { onRetrieve, onUpdate, serverDispatcher: sd });

    await sr.process([]);

    // After process() resolves the SD must be resumed. Push an active cursor and
    // verify that onDispatch fires — proving the SD is not stuck in a paused state.
    const record = makeRecord('probe-1', 'Probe');
    const probeAudit = auditor.createAuditFrom(record);
    const lastAuditEntryId = probeAudit.entries[0]!.id;
    sd.push([{
      collectionName: 'items',
      records: [{ record, lastAuditEntryId, hash: 'mock-hash-probe-1' } as never],
    }]);

    // Allow the microtask queue to drain so the async dispatch can run.
    await new Promise(r => setTimeout(r, 0));

    expect(onDispatch).toHaveBeenCalled();
  });

  it('resumes SD even if onUpdate throws', async () => {
    const { sd } = makeSD();
    const resumeSpy = vi.spyOn(sd, 'resume');

    const onRetrieve = vi.fn().mockResolvedValue([]);
    const onUpdate = vi.fn().mockRejectedValue(new Error('DB error'));
    const sr = new ServerReceiver(mockLogger, { onRetrieve, onUpdate, serverDispatcher: sd });

    const record = makeRecord('r1', 'Alice');
    const audit = auditor.createAuditFrom(record);
    const request: ClientDispatcherRequest = [{
      collectionName: 'items',
      records: [{ id: 'r1', hash: 'mock-hash-r1', entries: audit.entries }],
    }];

    await expect(sr.process(request)).rejects.toThrow('DB error');
    expect(resumeSpy).toHaveBeenCalledOnce();
  });

  it('processes new record with Created entry', async () => {
    const { sd } = makeSD();

    const record = makeRecord('r1', 'Alice');
    const audit = auditor.createAuditFrom(record);

    const onRetrieve = vi.fn().mockResolvedValue([]); // no server state
    const onUpdate = vi.fn().mockResolvedValue([{
      collectionName: 'items',
      successfulRecordIds: ['r1'],
    }]);
    const sr = new ServerReceiver(mockLogger, { onRetrieve, onUpdate, serverDispatcher: sd });

    const request: ClientDispatcherRequest = [{
      collectionName: 'items',
      records: [{ id: 'r1', hash: 'mock-hash-r1', entries: audit.entries }],
    }];

    const result = await sr.process(request);
    expect(onUpdate).toHaveBeenCalledOnce();
    const successIds = result.find(r => r.collectionName === 'items')?.successfulRecordIds ?? [];
    expect(successIds).toContain('r1');
  });

  it('skips new record if first entry is not Created', async () => {
    const { sd } = makeSD();

    const onRetrieve = vi.fn().mockResolvedValue([]);
    const onUpdate = vi.fn().mockResolvedValue([]);
    const sr = new ServerReceiver(mockLogger, { onRetrieve, onUpdate, serverDispatcher: sd });

    // Entry that is Updated, not Created
    const fakeUpdateEntry = { type: AuditEntryType.Updated, id: 'ulid-1', ops: [] };
    const request: ClientDispatcherRequest = [{
      collectionName: 'items',
      records: [{ id: 'r1', entries: [fakeUpdateEntry as any] }],
    }];

    const result = await sr.process(request);
    expect(mockLogger.error).toHaveBeenCalled();
    const successIds = result.find(r => r.collectionName === 'items')?.successfulRecordIds ?? [];
    expect(successIds).not.toContain('r1');
  });

  it('merges existing record audit', async () => {
    const { sd } = makeSD();

    const record = makeRecord('r1', 'Alice');
    const serverAudit = auditor.createAuditFrom(record);

    const serverStates: MXDBRecordStates = [{
      collectionName: 'items',
      records: [{ record, audit: serverAudit.entries }],
    }];

    const onRetrieve = vi.fn().mockResolvedValue(serverStates);
    const onUpdate = vi.fn().mockResolvedValue([{
      collectionName: 'items',
      successfulRecordIds: ['r1'],
    }]);
    const sr = new ServerReceiver(mockLogger, { onRetrieve, onUpdate, serverDispatcher: sd });

    // Client sends an update
    const updatedRecord = makeRecord('r1', 'Bob');
    const clientAudit = auditor.updateAuditWith(updatedRecord, serverAudit);

    const request: ClientDispatcherRequest = [{
      collectionName: 'items',
      records: [{ id: 'r1', hash: 'mock-hash-r1', entries: clientAudit.entries }],
    }];

    const result = await sr.process(request);
    expect(onUpdate).toHaveBeenCalledOnce();
    const successIds = result.find(r => r.collectionName === 'items')?.successfulRecordIds ?? [];
    expect(successIds).toContain('r1');

    // Verify the merged state was passed to onUpdate
    const updateArg = onUpdate.mock.calls[0][0] as MXDBRecordStates;
    const updatedState = updateArg[0]?.records[0];
    expect('record' in updatedState!).toBe(true);
  });

  it('handles branched-only active record — seeds filter, no onUpdate', async () => {
    const { sd } = makeSD();
    const updateFilterSpy = vi.spyOn(sd, 'updateFilter');

    const record = makeRecord('r1', 'Alice');
    const serverAudit = auditor.createAuditFrom(record);
    const branchId = auditor.generateUlid();
    const branchedAudit = auditor.collapseToAnchor(serverAudit, branchId);

    const serverStates: MXDBRecordStates = [{
      collectionName: 'items',
      records: [{ record, audit: serverAudit.entries }],
    }];

    const onRetrieve = vi.fn().mockResolvedValue(serverStates);
    const onUpdate = vi.fn().mockResolvedValue([]);
    const sr = new ServerReceiver(mockLogger, { onRetrieve, onUpdate, serverDispatcher: sd });

    // Branched-only request (only Branched entry, stripped = empty)
    const request: ClientDispatcherRequest = [{
      collectionName: 'items',
      records: [{ id: 'r1', hash: 'mock-hash-r1', entries: branchedAudit.entries }],
    }];

    const result = await sr.process(request);

    // onUpdate should not be called since there are no pending changes
    expect(onUpdate).not.toHaveBeenCalled();

    // r1 should still be in successfulRecordIds
    const successIds = result.find(r => r.collectionName === 'items')?.successfulRecordIds ?? [];
    expect(successIds).toContain('r1');

    // updateFilter should have been called with the seed
    expect(updateFilterSpy).toHaveBeenCalled();
  });

  it('pushes cursor to SD when server hash differs from client hash', async () => {
    const { sd } = makeSD();
    const pushSpy = vi.spyOn(sd, 'push');

    const record = makeRecord('r1', 'Alice');
    const serverAudit = auditor.createAuditFrom(record);
    const branchId = auditor.generateUlid();
    const branchedAudit = auditor.collapseToAnchor(serverAudit, branchId);

    const serverStates: MXDBRecordStates = [{
      collectionName: 'items',
      records: [{ record, audit: serverAudit.entries }],
    }];

    const onRetrieve = vi.fn().mockResolvedValue(serverStates);
    const onUpdate = vi.fn().mockResolvedValue([]);
    const sr = new ServerReceiver(mockLogger, { onRetrieve, onUpdate, serverDispatcher: sd });

    // Client sends branched-only with a DIFFERENT hash
    const request: ClientDispatcherRequest = [{
      collectionName: 'items',
      records: [{ id: 'r1', hash: 'different-hash', entries: branchedAudit.entries }],
    }];

    await sr.process(request);
    // Server hash is mock-hash-r1, client hash is different-hash — should push
    expect(pushSpy).toHaveBeenCalledOnce();
  });

  it('does not push when hashes match (client already up to date)', async () => {
    const { sd } = makeSD();
    const pushSpy = vi.spyOn(sd, 'push');

    const record = makeRecord('r1', 'Alice');
    const serverAudit = auditor.createAuditFrom(record);
    const branchId = auditor.generateUlid();
    const branchedAudit = auditor.collapseToAnchor(serverAudit, branchId);

    const serverStates: MXDBRecordStates = [{
      collectionName: 'items',
      records: [{ record, audit: serverAudit.entries }],
    }];

    const onRetrieve = vi.fn().mockResolvedValue(serverStates);
    const onUpdate = vi.fn().mockResolvedValue([]);
    const sr = new ServerReceiver(mockLogger, { onRetrieve, onUpdate, serverDispatcher: sd });

    // Client hash matches server hash (mock-hash-r1)
    const request: ClientDispatcherRequest = [{
      collectionName: 'items',
      records: [{ id: 'r1', hash: 'mock-hash-r1', entries: branchedAudit.entries }],
    }];

    await sr.process(request);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('server-deleted record: client update is persisted as tombstone, delete cursor pushed', async () => {
    const { sd, onDispatch } = makeSD();
    const pushSpy = vi.spyOn(sd, 'push');

    // Build server state: Created then Deleted — the record is tombstoned on the server.
    const record = makeRecord('r1', 'Alice');
    const serverAudit = auditor.createAuditFrom(record);
    const deletedAudit = auditor.delete(serverAudit);

    const serverStates: MXDBRecordStates = [{
      collectionName: 'items',
      // MXDBDeletedRecordState: recordId + audit, no record field
      records: [{ recordId: 'r1', audit: deletedAudit.entries }],
    }];

    const onRetrieve = vi.fn().mockResolvedValue(serverStates);
    // onUpdate must ACK r1 so the SR treats the persist as successful
    const onUpdate = vi.fn().mockResolvedValue([{
      collectionName: 'items',
      successfulRecordIds: ['r1'],
    }]);
    const sr = new ServerReceiver(mockLogger, { onRetrieve, onUpdate, serverDispatcher: sd });

    // Client doesn't know about the deletion — it sends an Updated entry and includes a hash.
    const clientAudit = auditor.updateAuditWith({ id: 'r1', name: 'Bob' }, serverAudit);
    const strippedEntries = clientAudit.entries.filter(e => e.type !== AuditEntryType.Branched);

    const request: ClientDispatcherRequest = [{
      collectionName: 'items',
      records: [{ id: 'r1', hash: 'mock-hash-r1', entries: strippedEntries }],
    }];

    const result = await sr.process(request);

    // onUpdate must be called — the merged audit (server deleted + client updated) is persisted.
    expect(onUpdate).toHaveBeenCalledOnce();

    // The state passed to onUpdate must be a tombstone (MXDBDeletedRecordState: no record field).
    const updateArg = onUpdate.mock.calls[0][0] as MXDBRecordStates;
    const persistedState = updateArg[0]?.records[0];
    expect(persistedState).toBeDefined();
    expect('record' in persistedState!).toBe(false);
    expect((persistedState as { recordId: string }).recordId).toBe('r1');

    // r1 must be ACKed to the client so it can collapse its local audit.
    const successIds = result.find(r => r.collectionName === 'items')?.successfulRecordIds ?? [];
    expect(successIds).toContain('r1');

    // The SD must receive a delete cursor (recordId + lastAuditEntryId, no record field)
    // so the client learns the record is tombstoned.
    expect(pushSpy).toHaveBeenCalledOnce();
    const pushPayload = pushSpy.mock.calls[0]![0] as unknown as MXDBRecordCursors;
    const pushedCursor = pushPayload[0]?.records[0];
    expect(pushedCursor).toBeDefined();
    expect('record' in pushedCursor!).toBe(false);
    expect((pushedCursor as { recordId: string }).recordId).toBe('r1');

    // Confirm the SD actually dispatches — not stuck paused.
    await new Promise(r => setTimeout(r, 0));
    expect(onDispatch).toHaveBeenCalled();
  });
});
