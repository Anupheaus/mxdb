import '@anupheaus/common';
import { describe, it, expect } from 'vitest';
import type { Record as MXDBRecord } from '@anupheaus/common';
import {
  auditor,
  AuditEntryType,
  OperationType,
  type AuditCreatedEntry,
  type AuditUpdateEntry,
  type AuditDeletedEntry,
  type AuditBranchedEntry,
  type AuditRestoredEntry,
} from '../../common';
import { toServerAuditOf } from './toServerAuditOf';

// ─── Test record type ──────────────────────────────────────────────────────────

type TestRecord = MXDBRecord & { name?: string; value?: number };

const ACTING_USER_ID = 'user-acting';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<TestRecord> = {}): TestRecord {
  return { id: 'rec-1', name: 'Alice', value: 1, ...overrides };
}

function makeCreatedEntry(record: TestRecord): AuditCreatedEntry<TestRecord> {
  return { type: AuditEntryType.Created, id: auditor.generateUlid(), record };
}

function makeUpdatedEntry(ops: AuditUpdateEntry['ops'] = []): AuditUpdateEntry {
  return { type: AuditEntryType.Updated, id: auditor.generateUlid(), ops };
}

function makeDeletedEntry(): AuditDeletedEntry {
  return { type: AuditEntryType.Deleted, id: auditor.generateUlid() };
}

function makeBranchedEntry(): AuditBranchedEntry {
  return { type: AuditEntryType.Branched, id: auditor.generateUlid() };
}

function makeRestoredEntry(record?: TestRecord): AuditRestoredEntry<TestRecord> {
  return record != null
    ? { type: AuditEntryType.Restored, id: auditor.generateUlid(), record }
    : { type: AuditEntryType.Restored, id: auditor.generateUlid() };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('toServerAuditOf', () => {

  describe('output id', () => {
    it('preserves the input audit id in the output', () => {
      const record = makeRecord();
      const audit = auditor.createAuditFrom(record);

      const result = toServerAuditOf(audit, ACTING_USER_ID);

      expect(result.id).toBe(audit.id);
    });
  });

  describe('userId stamping', () => {
    it('stamps actingUserId onto an entry that has no userId', () => {
      const record = makeRecord();
      const audit = auditor.createAuditFrom(record);

      const result = toServerAuditOf(audit, ACTING_USER_ID);

      const entry = result.entries[0];
      expect(entry?.userId).toBe(ACTING_USER_ID);
    });

    it('stamps actingUserId when the entry userId is an empty string', () => {
      const record = makeRecord();
      const audit = auditor.createAuditFrom(record);
      // Inject an empty-string userId to simulate an unset server entry
      const entryWithEmptyUser = { ...audit.entries[0]!, userId: '' };
      const auditWithEmptyUser = { id: audit.id, entries: [entryWithEmptyUser] };

      const result = toServerAuditOf(auditWithEmptyUser, ACTING_USER_ID);

      expect(result.entries[0]?.userId).toBe(ACTING_USER_ID);
    });

    it('preserves an existing non-empty userId without overwriting it', () => {
      const existingUserId = 'user-original';
      const record = makeRecord();
      const audit = auditor.createAuditFrom(record);
      const entryWithUser = { ...audit.entries[0]!, userId: existingUserId };
      const auditWithUser = { id: audit.id, entries: [entryWithUser] };

      const result = toServerAuditOf(auditWithUser, ACTING_USER_ID);

      expect(result.entries[0]?.userId).toBe(existingUserId);
    });
  });

  describe('non-delete entries pass through', () => {
    it('passes a Created entry through with userId added and no record modification', () => {
      const record = makeRecord();
      const createdEntry = makeCreatedEntry(record);
      const audit = { id: record.id, entries: [createdEntry] };

      const result = toServerAuditOf(audit, ACTING_USER_ID);

      const outEntry = result.entries[0];
      expect(outEntry?.type).toBe(AuditEntryType.Created);
      expect(outEntry?.userId).toBe(ACTING_USER_ID);
      expect((outEntry as AuditCreatedEntry<TestRecord>).record).toEqual(record);
    });

    it('passes an Updated entry through with userId added', () => {
      const ops: AuditUpdateEntry['ops'] = [{ type: OperationType.Replace, path: 'name', value: 'Bob' }];
      const updatedEntry = makeUpdatedEntry(ops);
      const createdEntry = makeCreatedEntry(makeRecord());
      const audit = { id: 'rec-1', entries: [createdEntry, updatedEntry] };

      const result = toServerAuditOf(audit, ACTING_USER_ID);

      const outUpdated = result.entries.find(e => e.type === AuditEntryType.Updated);
      expect(outUpdated?.userId).toBe(ACTING_USER_ID);
      expect((outUpdated as AuditUpdateEntry).ops).toEqual(ops);
    });

    it('passes a Branched entry through with userId added and no extra fields', () => {
      const branchedEntry = makeBranchedEntry();
      const createdEntry = makeCreatedEntry(makeRecord());
      const audit = { id: 'rec-1', entries: [createdEntry, branchedEntry] };

      const result = toServerAuditOf(audit, ACTING_USER_ID);

      const outBranched = result.entries.find(e => e.type === AuditEntryType.Branched);
      expect(outBranched?.userId).toBe(ACTING_USER_ID);
      // Branched should not have a record field
      expect((outBranched as Record<string, unknown>)['record']).toBeUndefined();
      expect('record' in (outBranched as object)).toBe(false);
    });

    it('passes a Restored entry through with userId added', () => {
      const restoredRecord = makeRecord({ name: 'Restored' });
      const restoredEntry = makeRestoredEntry(restoredRecord);
      const createdEntry = makeCreatedEntry(makeRecord());
      const deletedEntry = makeDeletedEntry();
      const audit = { id: 'rec-1', entries: [createdEntry, deletedEntry, restoredEntry] };

      const result = toServerAuditOf(audit, ACTING_USER_ID);

      const outRestored = result.entries.find(e => e.type === AuditEntryType.Restored);
      expect(outRestored?.userId).toBe(ACTING_USER_ID);
      expect((outRestored as AuditRestoredEntry<TestRecord>).record).toEqual(restoredRecord);
    });
  });

  describe('delete snapshot — replay', () => {
    it('adds a record snapshot to a Deleted entry via replay when no deleteSnapshots are given', () => {
      const record = makeRecord({ name: 'BeforeDelete' });
      const createdEntry = makeCreatedEntry(record);
      const deletedEntry = makeDeletedEntry();
      const audit = { id: record.id, entries: [createdEntry, deletedEntry] };

      const result = toServerAuditOf(audit, ACTING_USER_ID);

      const outDeleted = result.entries.find(e => e.type === AuditEntryType.Deleted);
      expect(outDeleted).toBeDefined();
      // The replayed snapshot must reflect the created record state
      const outRecord = (outDeleted as { record?: TestRecord })?.record;
      expect(outRecord).toBeDefined();
      expect(outRecord?.id).toBe(record.id);
      expect(outRecord?.name).toBe('BeforeDelete');
    });

    it('replays through Updated entries to produce the correct snapshot for a Deleted entry', () => {
      const originalRecord = makeRecord({ name: 'Original', value: 1 });
      const audit = auditor.createAuditFrom(originalRecord);
      const auditAfterUpdate = auditor.updateAuditWith(makeRecord({ name: 'Updated', value: 2 }), audit);
      const auditAfterDelete = auditor.delete(auditAfterUpdate);

      const result = toServerAuditOf(auditAfterDelete, ACTING_USER_ID);

      const outDeleted = result.entries.find(e => e.type === AuditEntryType.Deleted);
      const outRecord = (outDeleted as { record?: TestRecord })?.record;
      expect(outRecord?.name).toBe('Updated');
      expect(outRecord?.value).toBe(2);
    });

    it('falls back to an id-only stub when the Deleted entry has no preceding Created entry to replay from', () => {
      // A Deleted entry with nothing before it — no Created or baseRecord
      const deletedEntry = makeDeletedEntry();
      const audit = { id: 'orphan-rec', entries: [deletedEntry] };

      const result = toServerAuditOf(audit, ACTING_USER_ID);

      const outDeleted = result.entries.find(e => e.type === AuditEntryType.Deleted);
      const outRecord = (outDeleted as { record?: TestRecord })?.record;
      expect(outRecord).toBeDefined();
      expect(outRecord?.id).toBe('orphan-rec');
    });
  });

  describe('delete snapshot — deleteSnapshots param', () => {
    it('uses the live deleteSnapshot record for the chronologically latest Deleted entry', () => {
      const record = makeRecord({ name: 'BeforeDelete' });
      const liveRecord: TestRecord = { id: record.id, name: 'LiveSnapshot', value: 99 };
      const createdEntry = makeCreatedEntry(record);
      const deletedEntry = makeDeletedEntry();
      const audit = { id: record.id, entries: [createdEntry, deletedEntry] };

      const result = toServerAuditOf(audit, ACTING_USER_ID, {
        deleteSnapshots: { [record.id]: liveRecord },
      });

      const outDeleted = result.entries.find(e => e.type === AuditEntryType.Deleted);
      const outRecord = (outDeleted as { record?: TestRecord })?.record;
      expect(outRecord?.name).toBe('LiveSnapshot');
      expect(outRecord?.value).toBe(99);
    });

    it('uses replayed snapshot for an earlier Deleted entry even when deleteSnapshots is provided for a later one', () => {
      const record = makeRecord({ name: 'Original' });
      const createdEntry = makeCreatedEntry(record);
      const firstDeletedEntry = makeDeletedEntry();
      const restoredEntry = makeRestoredEntry(makeRecord({ name: 'Restored' }));
      const secondDeletedEntry = makeDeletedEntry();
      const liveRecord: TestRecord = { id: record.id, name: 'LiveRecord', value: 42 };
      const audit = { id: record.id, entries: [createdEntry, firstDeletedEntry, restoredEntry, secondDeletedEntry] };

      const result = toServerAuditOf(audit, ACTING_USER_ID, {
        deleteSnapshots: { [record.id]: liveRecord },
      });

      // The first Deleted entry should use a replayed snapshot (not the live one)
      const outFirstDeleted = result.entries.find(
        e => e.type === AuditEntryType.Deleted && e.id === firstDeletedEntry.id,
      );
      const firstRecord = (outFirstDeleted as { record?: TestRecord })?.record;
      // Replayed up to the first Deleted: only Created is before it, so name should be 'Original'
      expect(firstRecord?.name).toBe('Original');

      // The second Deleted entry (latest) should use the live snapshot
      const outLastDeleted = result.entries.find(
        e => e.type === AuditEntryType.Deleted && e.id === secondDeletedEntry.id,
      );
      const lastRecord = (outLastDeleted as { record?: TestRecord })?.record;
      expect(lastRecord?.name).toBe('LiveRecord');
    });
  });

  describe('existing delete record is preserved', () => {
    it('keeps an existing record on a Deleted entry without recomputing it', () => {
      const existingSnap: TestRecord = { id: 'rec-1', name: 'ExistingSnap', value: 7 };
      const deletedEntryWithRecord = {
        ...makeDeletedEntry(),
        record: existingSnap,
      };
      const createdEntry = makeCreatedEntry(makeRecord({ name: 'Different' }));
      const audit = { id: 'rec-1', entries: [createdEntry, deletedEntryWithRecord] };

      const result = toServerAuditOf(audit, ACTING_USER_ID);

      const outDeleted = result.entries.find(e => e.type === AuditEntryType.Deleted);
      const outRecord = (outDeleted as { record?: TestRecord })?.record;
      // Must keep the existing snapshot, not the replayed one
      expect(outRecord?.name).toBe('ExistingSnap');
      expect(outRecord?.value).toBe(7);
    });
  });

  describe('filterValidEntries stripping', () => {
    it('strips entries missing id', () => {
      const validEntry = makeCreatedEntry(makeRecord());
      const entryMissingId = { type: AuditEntryType.Created, record: makeRecord() };
      const audit = { id: 'rec-1', entries: [validEntry, entryMissingId] };

      const result = toServerAuditOf(audit, ACTING_USER_ID);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.id).toBe(validEntry.id);
    });

    it('strips entries missing type', () => {
      const validEntry = makeCreatedEntry(makeRecord());
      const entryMissingType = { id: auditor.generateUlid(), record: makeRecord() };
      const audit = { id: 'rec-1', entries: [validEntry, entryMissingType] };

      const result = toServerAuditOf(audit, ACTING_USER_ID);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.id).toBe(validEntry.id);
    });

    it('strips null entries without throwing', () => {
      const validEntry = makeCreatedEntry(makeRecord());
      const audit = { id: 'rec-1', entries: [validEntry, null, undefined] as unknown[] };

      const result = toServerAuditOf(audit, ACTING_USER_ID);

      expect(result.entries).toHaveLength(1);
    });
  });

  describe('output shape', () => {
    it('returns all entry types from a mixed audit, each with userId', () => {
      const record = makeRecord();
      const createdEntry = makeCreatedEntry(record);
      const updatedEntry = makeUpdatedEntry([]);
      const branchedEntry = makeBranchedEntry();
      const deletedEntry = makeDeletedEntry();
      const audit = { id: record.id, entries: [createdEntry, updatedEntry, branchedEntry, deletedEntry] };

      const result = toServerAuditOf(audit, ACTING_USER_ID);

      // All 4 entries should be present
      expect(result.entries).toHaveLength(4);
      // All entries should have userId
      for (const entry of result.entries) {
        expect(entry.userId).toBe(ACTING_USER_ID);
      }
      // The Deleted entry must have a record
      const outDeleted = result.entries.find(e => e.type === AuditEntryType.Deleted);
      expect((outDeleted as { record?: TestRecord })?.record).toBeDefined();
    });
  });
});
