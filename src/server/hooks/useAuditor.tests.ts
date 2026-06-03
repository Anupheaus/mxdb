import { describe, it, expect } from 'vitest';
import { auditor } from '../../common';
import { useAuditor } from './useAuditor';

interface TestRecord {
  id: string;
  name: string;
}

describe('useAuditor', () => {

  // ─── fullAudit flag ──────────────────────────────────────────────────────────

  describe('fullAudit flag', () => {
    it('exposes fullAudit === true when called with true', () => {
      const result = useAuditor(true);
      expect(result.fullAudit).toBe(true);
    });

    it('exposes fullAudit === false when called with false', () => {
      const result = useAuditor(false);
      expect(result.fullAudit).toBe(false);
    });
  });

  // ─── spreads auditor API ─────────────────────────────────────────────────────

  describe('spreads auditor API', () => {
    it('exposes createAuditFrom as a function', () => {
      expect(typeof useAuditor(true).createAuditFrom).toBe('function');
    });

    it('exposes entriesOf as a function', () => {
      expect(typeof useAuditor(true).entriesOf).toBe('function');
    });

    it('exposes isDeleted as a function', () => {
      expect(typeof useAuditor(true).isDeleted).toBe('function');
    });
  });

  // ─── isAudit ─────────────────────────────────────────────────────────────────

  describe('isAudit', () => {
    it('returns true for a valid full-audit document', () => {
      const record: TestRecord = { id: 'r1', name: 'Alice' };
      const audit = auditor.createAuditFrom(record);
      const result = useAuditor(true);
      expect(result.isAudit(audit)).toBe(true);
    });

    it('returns true for a valid sync-only audit document with useAuditor(false)', () => {
      const record: TestRecord = { id: 'r1', name: 'Alice' };
      const audit = auditor.createAuditFrom(record);
      const result = useAuditor(false);
      expect(result.isAudit(audit)).toBe(true);
    });

    it('returns false for a plain record (no entries array)', () => {
      const plain: TestRecord = { id: 'r1', name: 'Alice' };
      const result = useAuditor(true);
      expect(result.isAudit(plain)).toBe(false);
    });

    it('returns false for null', () => {
      const result = useAuditor(true);
      expect(result.isAudit(null)).toBe(false);
    });

    it('does not throw when called with fullAudit=true', () => {
      const record: TestRecord = { id: 'r1', name: 'Alice' };
      const audit = auditor.createAuditFrom(record);
      expect(() => useAuditor(true).isAudit(audit)).not.toThrow();
    });

    it('does not throw when called with fullAudit=false', () => {
      const record: TestRecord = { id: 'r1', name: 'Alice' };
      const audit = auditor.createAuditFrom(record);
      expect(() => useAuditor(false).isAudit(audit)).not.toThrow();
    });

    it('fullAudit=false accepts a sync-only (Branched + empty Updated) audit that fullAudit=true rejects', () => {
      // A Branched anchor followed by an Updated entry with empty ops is the sync-only
      // pending shape. isSyncOnlyAuditValid accepts it; isFullAuditValid rejects it.
      // This verifies that useAuditor correctly forwards the fullAudit flag.
      const syncOnlyAudit = {
        id: 'r2',
        entries: [
          { type: 4, id: 'e1' },                        // AuditEntryType.Branched
          { type: 1, id: 'e2', ops: [] as unknown[] },   // AuditEntryType.Updated, empty ops
        ],
      };
      expect(useAuditor(false).isAudit(syncOnlyAudit)).toBe(true);
      expect(useAuditor(true).isAudit(syncOnlyAudit)).toBe(false);
    });
  });

  // ─── merge ───────────────────────────────────────────────────────────────────

  describe('merge', () => {
    it('exposes merge as a function', () => {
      expect(typeof useAuditor(true).merge).toBe('function');
    });

    it('merging two audits from the same record does not throw (fullAudit=true)', () => {
      const record: TestRecord = { id: 'r1', name: 'Alice' };
      const serverAudit = auditor.createAuditFrom(record);
      const clientAudit = auditor.createAuditFrom(record);
      expect(() => useAuditor(true).merge(serverAudit, clientAudit)).not.toThrow();
    });

    it('merging two audits from the same record does not throw (fullAudit=false)', () => {
      const record: TestRecord = { id: 'r1', name: 'Alice' };
      const serverAudit = auditor.createAuditFrom(record);
      const clientAudit = auditor.createAuditFrom(record);
      expect(() => useAuditor(false).merge(serverAudit, clientAudit)).not.toThrow();
    });

    it('merge result is an audit document with the correct id', () => {
      const record: TestRecord = { id: 'r1', name: 'Alice' };
      const serverAudit = auditor.createAuditFrom(record);
      const clientAudit = auditor.createAuditFrom(record);
      const merged = useAuditor(true).merge(serverAudit, clientAudit);
      expect(merged).toMatchObject({ id: 'r1', entries: expect.any(Array) });
    });
  });
});
