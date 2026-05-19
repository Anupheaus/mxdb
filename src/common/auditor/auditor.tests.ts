import { describe, it, expect } from 'vitest';
import type { Record as MXDBRecord } from '@anupheaus/common';
import { decodeTime } from 'ulidx';
import {
  auditor,
  AuditEntryType,
  getIsAuditRejectionReason,
  type AuditCreatedEntry,
  type AuditOf,
} from '..';

type TestRecord = MXDBRecord & { value?: number; name?: string; untouched?: string };

function makeRecord(overrides: Partial<TestRecord> = {}): TestRecord {
  return { id: 'r1', name: 'v1', value: 1, ...overrides } as TestRecord;
}

describe('auditor core API', () => {
  describe('createAuditFrom', () => {
    it('creates a Created entry with correct shape and version', () => {
      const record = makeRecord();
      const audit = auditor.createAuditFrom(record);

      expect(audit.id).toBe(record.id);
      expect(audit.entries.length).toBe(1);

      const entry = audit.entries[0] as AuditCreatedEntry<TestRecord>;
      expect(entry.type).toBe(AuditEntryType.Created);
      expect(entry.record).toEqual(record);
      expect(decodeTime(entry.id)).toBeGreaterThan(0);
    });
  });

  describe('updateAuditWith + createRecordFrom', () => {
    it('does nothing when record has not changed', () => {
      const record = makeRecord();
      const audit = auditor.createAuditFrom(record);

      const updated = auditor.updateAuditWith(record, audit);
      expect(updated.entries).toHaveLength(audit.entries.length);
    });

    it('appends an Updated entry and replays changes', () => {
      const original = makeRecord({ name: 'v1' });
      const audit1 = auditor.createAuditFrom(original);

      const modified = makeRecord({ name: 'v2' });
      const audit2 = auditor.updateAuditWith(modified, audit1);

      expect(audit2.entries.length).toBe(2);
      const updatedEntry = audit2.entries[1];
      expect(updatedEntry!.type).toBe(AuditEntryType.Updated);

      const replayed = auditor.createRecordFrom(audit2);
      expect(replayed).toMatchObject({ id: 'r1', name: 'v2' });
    });
  });

  describe('delete / restore / isDeleted', () => {
    it('marks an audit as deleted and createRecordFrom returns undefined', () => {
      const audit = auditor.createAuditFrom(makeRecord());
      const deleted = auditor.delete(audit);

      expect(auditor.isDeleted(deleted)).toBe(true);
      expect(auditor.createRecordFrom(deleted)).toBeUndefined();
    });

    it('restoreTo resurrects a deleted audit', () => {
      const base = makeRecord({ name: 'base' });
      const audit1 = auditor.createAuditFrom(base);
      const deleted = auditor.delete(audit1);

      const restoredRecord = makeRecord({ name: 'restored' });
      const restored = auditor.restoreTo(deleted, restoredRecord);

      expect(auditor.isDeleted(restored)).toBe(false);
      const replayed = auditor.createRecordFrom(restored);
      expect(replayed).toMatchObject({ id: 'r1', name: 'restored' });
    });
  });

  describe('hasHistory / hasPendingChanges / collapseToAnchor', () => {
    it('reports entries and pending changes correctly', () => {
      const r1 = makeRecord();
      const audit1 = auditor.createAuditFrom(r1);

      expect(auditor.hasHistory(audit1)).toBe(false);
      expect(auditor.hasPendingChanges(audit1)).toBe(true);

      const anchor = auditor.generateUlid();
      const branched = auditor.collapseToAnchor(audit1, anchor);

      expect(auditor.hasHistory(branched)).toBe(false);
      expect(auditor.hasPendingChanges(branched)).toBe(false);
      expect(auditor.getBranchUlid(branched)).toBe(anchor);
    });

    it('preserves only entries after the anchor when collapsing', () => {
      const base = makeRecord({ value: 1 });
      let audit: AuditOf<TestRecord> = auditor.createAuditFrom(base);

      const r2 = makeRecord({ value: 2 });
      audit = auditor.updateAuditWith(r2, audit);
      const r3 = makeRecord({ value: 3 });
      audit = auditor.updateAuditWith(r3, audit);

      const anchorEntry = audit.entries[1];
      if (anchorEntry == null) throw new Error('expected second audit entry');
      const anchorId = anchorEntry.id;
      const collapsed = auditor.collapseToAnchor(audit, anchorId);

      expect(collapsed.entries[0]!.id).toBe(anchorId);
      expect(collapsed.entries.length).toBe(1 + (audit.entries.length - 2));
    });
  });

  describe('isAudit (collection mode)', () => {
    it('accepts sync-only pending shape only when fullAudit is false', () => {
      const bid = auditor.generateUlid();
      const uid = auditor.generateUlid();
      const syncPending = {
        id: 'r1',
        entries: [
          {
            type: AuditEntryType.Branched,
            id: bid,
          },
          {
            type: AuditEntryType.Updated,
            id: uid,
            ops: [],
          },
        ],
      } as AuditOf<TestRecord>;

      expect(auditor.isAudit(syncPending, false)).toBe(true);
      expect(auditor.isAudit(syncPending, true)).toBe(false);
    });

    it('accepts microdiff Updated audits when fullAudit is true', () => {
      const record = makeRecord();
      const full = auditor.updateAuditWith(makeRecord({ name: 'changed' }), auditor.createAuditFrom(record));
      expect(auditor.isAudit(full, true)).toBe(true);
    });

    it('getIsAuditRejectionReason documents shape and mode failures', () => {
      expect(getIsAuditRejectionReason(null, true)).toMatch(/non-null object/);
      expect(getIsAuditRejectionReason({ id: 1, entries: [] } as unknown, false)).toMatch(/audit\.id must be a string/);
      expect(getIsAuditRejectionReason({ id: 'r1', entries: 'x' } as unknown, true)).toMatch(/entries must be an array/);
      const bid = auditor.generateUlid();
      const uid = auditor.generateUlid();
      const syncPending = {
        id: 'r1',
        entries: [
          { type: AuditEntryType.Branched, id: bid },
          { type: AuditEntryType.Updated, id: uid, ops: [] },
        ],
      } as AuditOf<TestRecord>;
      expect(getIsAuditRejectionReason(syncPending, true)).toMatch(/empty Updated|sync-only pending/);
    });

    it('isAudit with logger warns once when rejected', () => {
      const bid = auditor.generateUlid();
      const uid = auditor.generateUlid();
      const syncPending = {
        id: 'r1',
        entries: [
          { type: AuditEntryType.Branched, id: bid },
          { type: AuditEntryType.Updated, id: uid, ops: [] },
        ],
      } as AuditOf<TestRecord>;
      const warns: string[] = [];
      const logger = { warn: (m: string) => { warns.push(m); } } as import('@anupheaus/common').Logger;
      expect(auditor.isAudit(syncPending, true, logger)).toBe(false);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/isAudit rejected .* fullAudit=true/);
    });
  });

  describe('merge', () => {
    it('keeps existing entries when client has no new entries', () => {
      const record = makeRecord({ name: 'server' });
      const serverAudit = auditor.createAuditFrom(record);

      const merged = auditor.merge(serverAudit, serverAudit);
      expect(merged.entries.length).toBe(serverAudit.entries.length);
    });

    it('deduplicates entries by id when merging', () => {
      const record = makeRecord();
      const baseAudit = auditor.createAuditFrom(record);
      const updatedAudit = auditor.updateAuditWith(
        makeRecord({ name: 'changed' }),
        baseAudit,
      );

      const merged = auditor.merge(updatedAudit, updatedAudit);
      const ids = merged.entries.map(e => e.id);
      expect(ids).toHaveLength(new Set(ids).size);
    });

    it('merges pending-only client audit (Updated only) into valid server full audit', () => {
      const seed = makeRecord({ name: 'seed' });
      const serverAudit = auditor.createAuditFrom(seed);
      const fullClient = auditor.updateAuditWith(makeRecord({ name: 'client' }), auditor.createAuditFrom(seed));
      const pendingOnly: AuditOf<TestRecord> = {
        id: seed.id,
        entries: fullClient.entries.filter(e => e.type !== AuditEntryType.Created),
      };

      expect(auditor.isAudit(pendingOnly, true)).toBe(false);
      expect(pendingOnly.entries).toHaveLength(1);
      expect(pendingOnly.entries[0]?.type).toBe(AuditEntryType.Updated);

      const merged = auditor.merge(serverAudit, pendingOnly);
      expect(merged.entries.length).toBe(2);
      expect(auditor.createRecordFrom(merged)).toMatchObject({ id: seed.id, name: 'client' });
    });
  });

  describe('rebaseRecord', () => {
    it('applies only local changes on top of a new server record', () => {
      const oldServer = { id: 'r1', value: 1, untouched: 'x' } as TestRecord;
      const userRecord = { id: 'r1', value: 2, untouched: 'x' } as TestRecord;
      const newServer = { id: 'r1', value: 1, untouched: 'y' } as TestRecord;

      const rebased = auditor.rebaseRecord(oldServer, userRecord, newServer);

      expect(rebased.value).toBe(2);       // user change preserved
      expect(rebased.untouched).toBe('y'); // server change applied for untouched field
    });
  });

  describe('hashRecord', () => {
    it('produces a 16-char hex string that is stable for same content', async () => {
      const r1 = { id: 'r1', value: 42 } as TestRecord;
      const r2 = { id: 'r1', value: 42 } as TestRecord;

      const [h1, h2] = await Promise.all([
        auditor.hashRecord(r1),
        auditor.hashRecord(r2),
      ]);

      expect(h1).toMatch(/^[0-9a-f]{16}$/);
      expect(h1).toBe(h2);
    });

    it('changes when record content changes', async () => {
      const r1 = { id: 'r1', value: 42 } as TestRecord;
      const r2 = { id: 'r1', value: 43 } as TestRecord;

      const [h1, h2] = await Promise.all([
        auditor.hashRecord(r1),
        auditor.hashRecord(r2),
      ]);

      expect(h1).not.toBe(h2);
    });
  });

  describe('setClockDrift / generateUlid', () => {
    it('adjusts ULID time component when drift changes', () => {
      const id1 = auditor.generateUlid();
      const t1 = decodeTime(id1);

      // Simulate the client thinking the server is 1 second ahead
      auditor.setClockDrift(1_000);
      const id2 = auditor.generateUlid();
      const t2 = decodeTime(id2);

      // With positive drift, generated ULIDs should appear slightly earlier
      expect(t2).toBeLessThan(t1);
    });
  });
});

