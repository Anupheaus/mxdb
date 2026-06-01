import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@anupheaus/common'; // ensure Object.clone and other extensions are installed
import type { Logger } from '@anupheaus/common';
import { auditor } from '../auditor';
import {
  ClientReceiver,
  SyncPausedError,
  type MXDBRecordStates,
  type MXDBRecordCursors,
  type MXDBUpdateRequest,
  type MXDBSyncEngineResponse,
} from '.';

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

describe('ClientReceiver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('pause / resume', () => {
    it('throws SyncPausedError when paused', () => {
      const onRetrieve = vi.fn().mockReturnValue([]);
      const onUpdate = vi.fn().mockReturnValue([]);
      const cr = new ClientReceiver(mockLogger, { onRetrieve, onUpdate });

      cr.pause();
      expect(() => cr.process([])).toThrow(SyncPausedError);
      expect(onRetrieve).not.toHaveBeenCalled();
    });

    it('does not throw after resume', () => {
      const onRetrieve = vi.fn().mockReturnValue([]);
      const onUpdate = vi.fn().mockReturnValue([]);
      const cr = new ClientReceiver(mockLogger, { onRetrieve, onUpdate });

      cr.pause();
      cr.resume();
      expect(() => cr.process([])).not.toThrow();
    });
  });

  describe('process', () => {
    it('returns empty response for empty payload', () => {
      const onRetrieve = vi.fn().mockReturnValue([]);
      const onUpdate = vi.fn().mockReturnValue([]);
      const cr = new ClientReceiver(mockLogger, { onRetrieve, onUpdate });

      const result = cr.process([]);
      expect(result).toEqual([]);
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it('accepts active cursor when no local state exists', () => {
      const onRetrieve = vi.fn().mockReturnValue([]); // no local state
      const onUpdate = vi.fn().mockImplementation((updates: MXDBUpdateRequest) => {
        return updates.map(u => ({ collectionName: u.collectionName, successfulRecordIds: u.records?.map(r => r.record.id) ?? [] }));
      });
      const cr = new ClientReceiver(mockLogger, { onRetrieve, onUpdate });

      const record = makeRecord('r1', 'Alice');
      const payload: MXDBRecordCursors = [{
        collectionName: 'items',
        records: [{ record, lastAuditEntryId: 'ulid-1' }],
      }];

      const result = cr.process(payload);
      expect(onUpdate).toHaveBeenCalledOnce();
      const updateArg = onUpdate.mock.calls[0][0] as MXDBUpdateRequest;
      expect(updateArg[0]!.collectionName).toBe('items');
      expect(updateArg[0]!.records?.[0]!.record).toEqual(record);
      expect(updateArg[0]!.records?.[0]!.lastAuditEntryId).toBe('ulid-1');
      expect(result[0]!.successfulRecordIds).toContain('r1');
    });

    it('accepts delete cursor with no local state — already consistent, includes in successfulRecordIds', () => {
      const onRetrieve = vi.fn().mockReturnValue([]); // no local state
      const onUpdate = vi.fn().mockReturnValue([{ collectionName: 'items', successfulRecordIds: [] }]);
      const cr = new ClientReceiver(mockLogger, { onRetrieve, onUpdate });

      const payload: MXDBRecordCursors = [{
        collectionName: 'items',
        records: [{ recordId: 'r1', lastAuditEntryId: 'ulid-1' }],
      }];

      const result = cr.process(payload);
      // Should include r1 in successfulRecordIds via noLocalStateDeleteIds
      const successIds = result.find(r => r.collectionName === 'items')?.successfulRecordIds ?? [];
      expect(successIds).toContain('r1');
    });

    it('skips cursor when local audit has pending changes (not branch-only)', () => {
      const record = makeRecord('r1', 'Alice');
      // Create an audit with pending changes (Created + Updated — not branch-only)
      const audit = auditor.createAuditFrom(record);
      const updatedRecord = makeRecord('r1', 'Bob');
      const audit2 = auditor.updateAuditWith(updatedRecord, audit);

      const localStates: MXDBRecordStates = [{
        collectionName: 'items',
        records: [{ record, audit: audit2.entries }],
      }];

      const onRetrieve = vi.fn().mockReturnValue(localStates);
      const onUpdate = vi.fn().mockReturnValue([]);
      const cr = new ClientReceiver(mockLogger, { onRetrieve, onUpdate });

      const payload: MXDBRecordCursors = [{
        collectionName: 'items',
        records: [{ record: makeRecord('r1', 'Charlie'), lastAuditEntryId: 'ulid-999' }],
      }];

      const result = cr.process(payload);
      expect(onUpdate).not.toHaveBeenCalled();
      const successIds = result.find(r => r.collectionName === 'items')?.successfulRecordIds ?? [];
      expect(successIds).not.toContain('r1');
    });

    it('skips stale cursor (cursor.lastAuditEntryId <= branchUlid)', () => {
      const record = makeRecord('r1', 'Alice');
      const audit = auditor.createAuditFrom(record);
      const branchUlid = auditor.generateUlid();
      const branchedAudit = auditor.collapseToAnchor(audit, branchUlid);

      const localStates: MXDBRecordStates = [{
        collectionName: 'items',
        records: [{ record, audit: branchedAudit.entries }],
      }];

      const onRetrieve = vi.fn().mockReturnValue(localStates);
      const onUpdate = vi.fn().mockReturnValue([]);
      const cr = new ClientReceiver(mockLogger, { onRetrieve, onUpdate });

      // Use an older ULID (lexicographically smaller)
      const staleCursorId = '00000000000000000000000000'; // very old ULID
      const payload: MXDBRecordCursors = [{
        collectionName: 'items',
        records: [{ record: makeRecord('r1', 'Bob'), lastAuditEntryId: staleCursorId }],
      }];

      const result = cr.process(payload);
      expect(onUpdate).not.toHaveBeenCalled();
      const successIds = result.find(r => r.collectionName === 'items')?.successfulRecordIds ?? [];
      expect(successIds).not.toContain('r1');
    });

    it('accepts active cursor with empty anchor over a non-empty local branch (disableAudit updates)', () => {
      // Non-audited collections always emit an empty lastAuditEntryId, and the client
      // anchors the first synced record to a random ULID. A subsequent update also carries
      // an empty anchor; it must still apply (server is authoritative) rather than be skipped
      // as stale — otherwise the record is frozen on its first version forever.
      const record = makeRecord('r1', 'Alice');
      const audit = auditor.createAuditFrom(record);
      const branchUlid = auditor.generateUlid(); // non-empty local anchor, as DbCollection would create
      const branchedAudit = auditor.collapseToAnchor(audit, branchUlid);

      const localStates: MXDBRecordStates = [{
        collectionName: 'items',
        records: [{ record, audit: branchedAudit.entries }],
      }];

      const onRetrieve = vi.fn().mockReturnValue(localStates);
      const onUpdate = vi.fn().mockImplementation((updates: MXDBUpdateRequest): MXDBSyncEngineResponse =>
        updates.map(u => ({ collectionName: u.collectionName, successfulRecordIds: u.records?.map(r => r.record.id) ?? [] })),
      );
      const cr = new ClientReceiver(mockLogger, { onRetrieve, onUpdate });

      const payload: MXDBRecordCursors = [{
        collectionName: 'items',
        records: [{ record: makeRecord('r1', 'Bob'), lastAuditEntryId: '' }],
      }];

      const result = cr.process(payload);
      expect(onUpdate).toHaveBeenCalledOnce();
      const successIds = result.find(r => r.collectionName === 'items')?.successfulRecordIds ?? [];
      expect(successIds).toContain('r1');
    });

    it('accepts branch-only cursor when cursor is newer than branch ULID', () => {
      const record = makeRecord('r1', 'Alice');
      const audit = auditor.createAuditFrom(record);
      const branchUlid = '01000000000000000000000001'; // some ULID
      const branchedAudit = auditor.collapseToAnchor(audit, branchUlid);

      const localStates: MXDBRecordStates = [{
        collectionName: 'items',
        records: [{ record, audit: branchedAudit.entries }],
      }];

      const onRetrieve = vi.fn().mockReturnValue(localStates);
      const onUpdate = vi.fn().mockImplementation((updates: MXDBUpdateRequest): MXDBSyncEngineResponse => {
        return updates.map(u => ({ collectionName: u.collectionName, successfulRecordIds: u.records?.map(r => r.record.id) ?? [] }));
      });
      const cr = new ClientReceiver(mockLogger, { onRetrieve, onUpdate });

      // Newer ULID
      const newerCursorId = '09999999999999999999999999';
      const newRecord = makeRecord('r1', 'Bob');
      const payload: MXDBRecordCursors = [{
        collectionName: 'items',
        records: [{ record: newRecord, lastAuditEntryId: newerCursorId }],
      }];

      const result = cr.process(payload);
      expect(onUpdate).toHaveBeenCalledOnce();
      const successIds = result.find(r => r.collectionName === 'items')?.successfulRecordIds ?? [];
      expect(successIds).toContain('r1');
    });

    it('accepts branch-only cursor with no branch entry (treats as stale=false)', () => {
      // A Created-only audit — isBranchOnly is true (Created counts), but no branch ULID
      const record = makeRecord('r1', 'Alice');
      const audit = auditor.createAuditFrom(record);

      const localStates: MXDBRecordStates = [{
        collectionName: 'items',
        records: [{ record, audit: audit.entries }],
      }];

      const onRetrieve = vi.fn().mockReturnValue(localStates);
      const onUpdate = vi.fn().mockImplementation((updates: MXDBUpdateRequest): MXDBSyncEngineResponse => {
        return updates.map(u => ({ collectionName: u.collectionName, successfulRecordIds: u.records?.map(r => r.record.id) ?? [] }));
      });
      const cr = new ClientReceiver(mockLogger, { onRetrieve, onUpdate });

      const payload: MXDBRecordCursors = [{
        collectionName: 'items',
        records: [{ record: makeRecord('r1', 'Bob'), lastAuditEntryId: 'some-ulid' }],
      }];

      const result = cr.process(payload);
      expect(onUpdate).toHaveBeenCalledOnce();
      const successIds = result.find(r => r.collectionName === 'items')?.successfulRecordIds ?? [];
      expect(successIds).toContain('r1');
    });

    it('refuses to resurrect a locally-tombstoned record when an active cursor arrives', () => {
      // Scenario: the client has just deleted r1 locally (e.g. the user's update loop
      // wrote a tombstone while an S2C dispatch was in-flight through the network).
      // An active cursor for r1 then arrives at the CR. Delete-is-final: the client's
      // local tombstone must win and the active cursor must be skipped, NOT merged
      // into onUpdate (which would resurrect the record).
      const record = makeRecord('r1', 'Alice');
      const createAudit = auditor.createAuditFrom(record);
      const deletedAudit = auditor.delete(createAudit);

      // Local state is a tombstone (MXDBDeletedRecordState — no `record` field)
      const localStates: MXDBRecordStates = [{
        collectionName: 'items',
        records: [{ recordId: 'r1', audit: deletedAudit.entries }],
      }];

      const onRetrieve = vi.fn().mockReturnValue(localStates);
      const onUpdate = vi.fn().mockReturnValue([]);
      const cr = new ClientReceiver(mockLogger, { onRetrieve, onUpdate });

      // Incoming active cursor carrying a newer record for the tombstoned id
      const payload: MXDBRecordCursors = [{
        collectionName: 'items',
        records: [{ record: makeRecord('r1', 'Bob'), lastAuditEntryId: '09999999999999999999999999' }],
      }];

      const result = cr.process(payload);

      // onUpdate must NOT be called — resurrecting the record would be a bug
      expect(onUpdate).not.toHaveBeenCalled();

      // The active cursor must not appear in successfulRecordIds
      const successIds = result.find(r => r.collectionName === 'items')?.successfulRecordIds ?? [];
      expect(successIds).not.toContain('r1');

      // Should not log an error — the race is expected and handled
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('treats a delete cursor against a local tombstone as already-consistent (success, no resurrection)', () => {
      // Companion to the above: a delete cursor for an already-tombstoned record
      // must succeed (already consistent) without calling onUpdate and without
      // resurrecting anything.
      const record = makeRecord('r1', 'Alice');
      const createAudit = auditor.createAuditFrom(record);
      const deletedAudit = auditor.delete(createAudit);

      const localStates: MXDBRecordStates = [{
        collectionName: 'items',
        records: [{ recordId: 'r1', audit: deletedAudit.entries }],
      }];

      const onRetrieve = vi.fn().mockReturnValue(localStates);
      const onUpdate = vi.fn().mockReturnValue([]);
      const cr = new ClientReceiver(mockLogger, { onRetrieve, onUpdate });

      const payload: MXDBRecordCursors = [{
        collectionName: 'items',
        records: [{ recordId: 'r1', lastAuditEntryId: '09999999999999999999999999' }],
      }];

      const result = cr.process(payload);

      expect(onUpdate).not.toHaveBeenCalled();
      const successIds = result.find(r => r.collectionName === 'items')?.successfulRecordIds ?? [];
      expect(successIds).toContain('r1');
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('merges noLocalStateDeleteIds into onUpdate response', () => {
      const onRetrieve = vi.fn().mockReturnValue([]);
      // onUpdate returns success for some other record
      const onUpdate = vi.fn().mockReturnValue([{
        collectionName: 'items',
        successfulRecordIds: ['other-record'],
      }]);
      const cr = new ClientReceiver(mockLogger, { onRetrieve, onUpdate });

      const payload: MXDBRecordCursors = [{
        collectionName: 'items',
        records: [
          { recordId: 'deleted-r1', lastAuditEntryId: 'ulid-1' },
          { record: makeRecord('other-record', 'test'), lastAuditEntryId: 'ulid-2' },
        ],
      }];

      const result = cr.process(payload);
      const successIds = result.find(r => r.collectionName === 'items')?.successfulRecordIds ?? [];
      expect(successIds).toContain('deleted-r1');
      expect(successIds).toContain('other-record');
    });
  });
});
