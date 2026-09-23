import { describe, it, expect, vi } from 'vitest';
import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import { ulid } from 'ulidx';
import {
  AuditEntryType,
  OperationType,
  type AnyAuditOf,
  type AuditEntry,
  type AuditOf,
} from './auditor-models';
import {
  collapseToAnchor,
  createBranchFrom,
  createRecordFrom,
  deleteRecord,
  entriesOf,
  getAuditDocumentRejectionReason,
  getBranchUlid,
  getIsAuditRejectionReason,
  getLastEntryId,
  getLastEntryTimestamp,
  hasHistory,
  hasPendingChanges,
  isAudit,
  isAuditDocument,
  isBranchOnly,
  isDeleted,
  merge,
  rebaseRecord,
  restoreTo,
  updateAuditWith,
  type UlidGenerator,
} from './api';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

interface TestRecord extends MXDBRecord {
  name?: string;
  value?: number;
}

const RECORD_ID = 'r1';

/** Fixed-width, lexicographically ordered pseudo-ULIDs: `id(1) < id(2) < …`. */
function id(sequence: number): string {
  return `01J${String(sequence).padStart(23, '0')}`;
}

/** Deterministic ULID generator starting after any fixture ids used in a test. */
function makeUlidGenerator(start = 100): UlidGenerator {
  let next = start;
  return () => id(next++);
}

function makeRecord(overrides: Partial<TestRecord> = {}): TestRecord {
  return { id: RECORD_ID, name: 'original', value: 1, ...overrides };
}

function makeAudit(entries: AuditEntry<TestRecord>[]): AuditOf<TestRecord> {
  return { id: RECORD_ID, entries };
}

const created = (seq: number, record: TestRecord = makeRecord()): AuditEntry<TestRecord> =>
  ({ type: AuditEntryType.Created, id: id(seq), record });
const updated = (seq: number, name: string): AuditEntry<TestRecord> =>
  ({ type: AuditEntryType.Updated, id: id(seq), ops: [{ type: OperationType.Replace, path: 'name', value: name }] });
const emptyUpdated = (seq: number): AuditEntry<TestRecord> => ({ type: AuditEntryType.Updated, id: id(seq), ops: [] });
const deleted = (seq: number): AuditEntry<TestRecord> => ({ type: AuditEntryType.Deleted, id: id(seq) });
const restored = (seq: number): AuditEntry<TestRecord> => ({ type: AuditEntryType.Restored, id: id(seq) });
const branched = (seq: number): AuditEntry<TestRecord> => ({ type: AuditEntryType.Branched, id: id(seq) });

interface FakeLogger {
  logger: Logger;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

function makeLogger(): FakeLogger {
  const warn = vi.fn();
  const error = vi.fn();
  const logger = { warn, error, debug: vi.fn(), info: vi.fn(), silly: vi.fn() } as unknown as Logger;
  return { logger, warn, error };
}

// ─── Document shape guards ────────────────────────────────────────────────────

describe('audit document shape', () => {
  const notDocuments: [string, unknown, RegExp][] = [
    ['null', null, /non-null object \(got null\)/],
    ['undefined', undefined, /non-null object \(got undefined\)/],
    ['a string', 'audit', /non-null object \(got string\)/],
    ['a number id', { id: 1, entries: [] }, /audit\.id must be a string \(got number\)/],
    ['a missing id', { entries: [] }, /audit\.id must be a string \(got undefined\)/],
    ['a null id', { id: null, entries: [] }, /audit\.id must be a string \(got null\)/],
    ['object entries', { id: 'r1', entries: {} }, /audit\.entries must be an array \(got object\)/],
    ['missing entries', { id: 'r1' }, /audit\.entries must be an array \(got undefined\)/],
    ['an array', [], /audit\.id must be a string \(got undefined\)/],
  ];

  it.each(notDocuments)('rejects %s as an audit document', (_label, value) => {
    expect(isAuditDocument(value)).toBe(false);
  });

  it.each(notDocuments)('explains why %s is not an audit document', (_label, value, reason) => {
    expect(getAuditDocumentRejectionReason(value)).toMatch(reason);
  });

  it('accepts an object with a string id and an entries array', () => {
    expect(isAuditDocument({ id: 'r1', entries: [] })).toBe(true);
  });

  it('gives no rejection reason for a well-shaped document', () => {
    expect(getAuditDocumentRejectionReason({ id: 'r1', entries: [] })).toBeNull();
  });

  it('returns no entries when the entries field is malformed', () => {
    expect(entriesOf({ id: 'r1', entries: 'oops' } as unknown as AuditOf<TestRecord>)).toEqual([]);
  });
});

// ─── isAudit / getIsAuditRejectionReason ──────────────────────────────────────

describe('audit validation by collection mode', () => {
  const validSyncOnly: [string, AuditEntry<TestRecord>[]][] = [
    ['a lone Created entry', [created(1)]],
    ['a lone Branched anchor', [branched(1)]],
    ['an anchor followed by an empty Updated', [branched(1), emptyUpdated(2)]],
    ['an anchor followed by a Deleted', [created(1), deleted(2)]],
  ];

  const invalidSyncOnly: [string, AuditEntry<TestRecord>[], RegExp][] = [
    ['no entries', [], /requires 1–2 entries \(got 0\)/],
    ['three entries', [created(1), emptyUpdated(2), deleted(3)], /at most 2 entries \(got 3\)/],
    ['a first entry that is not an anchor', [deleted(1)], /first entry must be Created\(0\) or Branched\(4\) \(got type 2\)/],
    ['an Updated second entry carrying ops', [branched(1), updated(2, 'x')], /must have empty ops \(got ops\.length=1\)/],
    [
      'an Updated second entry with non-array ops',
      [branched(1), { type: AuditEntryType.Updated, id: id(2) } as AuditEntry<TestRecord>],
      /Updated\.ops must be an array/,
    ],
    ['a Restored second entry', [created(1), restored(2)], /must be Updated\(1\) with empty ops or Deleted\(2\) \(got type 3\)/],
  ];

  it.each(validSyncOnly)('accepts %s in sync-only mode', (_label, entries) => {
    expect(isAudit(makeAudit(entries), false)).toBe(true);
  });

  it.each(invalidSyncOnly)('rejects %s in sync-only mode', (_label, entries) => {
    expect(isAudit(makeAudit(entries), false)).toBe(false);
  });

  it.each(invalidSyncOnly)('explains why %s is rejected in sync-only mode', (_label, entries, reason) => {
    expect(getIsAuditRejectionReason(makeAudit(entries), false)).toMatch(reason);
  });

  const validFull: [string, AuditEntry<TestRecord>[]][] = [
    ['a lone Created entry', [created(1)]],
    ['a Created entry with updates', [created(1), updated(2, 'a'), updated(3, 'b')]],
    ['an anchor with a non-empty update', [branched(1), updated(2, 'a')]],
    ['an anchor with three entries including an empty update', [branched(1), emptyUpdated(2), deleted(3)]],
  ];

  const invalidFull: [string, AuditEntry<TestRecord>[], RegExp][] = [
    ['no entries', [], /at least one entry \(got 0\)/],
    ['a first entry that is not an anchor', [updated(1, 'a')], /first entry must be Created\(0\) or Branched\(4\) \(got type 1\)/],
    ['the sync-only anchor + empty Updated shape', [branched(1), emptyUpdated(2)], /rejects anchor \+ empty Updated/],
  ];

  it.each(validFull)('accepts %s in full-audit mode', (_label, entries) => {
    expect(isAudit(makeAudit(entries), true)).toBe(true);
  });

  it.each(invalidFull)('rejects %s in full-audit mode', (_label, entries) => {
    expect(isAudit(makeAudit(entries), true)).toBe(false);
  });

  it.each(invalidFull)('explains why %s is rejected in full-audit mode', (_label, entries, reason) => {
    expect(getIsAuditRejectionReason(makeAudit(entries), true)).toMatch(reason);
  });

  it('reports the document-shape problem before any mode-specific problem', () => {
    expect(getIsAuditRejectionReason({ id: 'r1' }, false)).toMatch(/audit\.entries must be an array/);
  });

  it('warns with a placeholder id when the rejected value has no string id', () => {
    const { logger, warn } = makeLogger();

    isAudit({ entries: [] }, true, logger);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('isAudit rejected id="?" fullAudit=true'));
  });

  it('does not warn when the audit is accepted', () => {
    const { logger, warn } = makeLogger();

    isAudit(makeAudit([created(1)]), true, logger);

    expect(warn).not.toHaveBeenCalled();
  });
});

// ─── updateAuditWith / deleteRecord / restoreTo ───────────────────────────────

describe('updateAuditWith', () => {
  it('tombstones the record when the current record is undefined', () => {
    const audit = makeAudit([created(1)]);

    const result = updateAuditWith<TestRecord>(undefined, audit, makeUlidGenerator());

    expect(isDeleted(result)).toBe(true);
  });

  it('diffs against the supplied base record instead of replaying the audit', () => {
    const audit = makeAudit([created(1, makeRecord({ name: 'from-audit' }))]);
    const baseRecord = makeRecord({ name: 'from-base' });

    const result = updateAuditWith(makeRecord({ name: 'from-base' }), audit, makeUlidGenerator(), baseRecord);

    expect(result).toBe(audit);
  });

  it('brings a tombstoned record back to the requested state', () => {
    const audit = makeAudit([created(1), deleted(2)]);
    const target = makeRecord({ name: 'revived' });

    const result = updateAuditWith(target, audit, makeUlidGenerator());

    expect(createRecordFrom(result)).toEqual(target);
  });

  it('keeps every prior entry when resurrecting a tombstoned record', () => {
    const audit = makeAudit([created(1), deleted(2)]);

    const result = updateAuditWith(makeRecord({ name: 'revived' }), audit, makeUlidGenerator());

    expect(result.entries.slice(0, 2)).toEqual(audit.entries);
  });
});

describe('deleteRecord', () => {
  it('does not append a second tombstone to an already-deleted audit', () => {
    const audit = makeAudit([created(1), deleted(2)]);

    expect(deleteRecord(audit, makeUlidGenerator())).toBe(audit);
  });

  it('appends a Deleted entry with a freshly generated ULID', () => {
    const audit = makeAudit([created(1)]);

    const result = deleteRecord(audit, makeUlidGenerator(50));

    expect(result.entries[1]).toEqual({ type: AuditEntryType.Deleted, id: id(50) });
  });
});

describe('restoreTo', () => {
  it('appends a payload-free Restored entry when the shadow already equals the target', () => {
    const record = makeRecord();
    const audit = makeAudit([created(1, record), deleted(2)]);

    const result = restoreTo(audit, record, makeUlidGenerator(50));

    expect(result.entries[2]).toEqual({ type: AuditEntryType.Restored, id: id(50) });
  });

  it('appends a Restored entry carrying the target when it differs from the shadow', () => {
    const audit = makeAudit([created(1), deleted(2)]);
    const target = makeRecord({ name: 'different' });

    const result = restoreTo(audit, target, makeUlidGenerator(50));

    expect(result.entries[2]).toEqual({ type: AuditEntryType.Restored, id: id(50), record: target });
  });

  it('appends a Created entry when the audit has no materialisable history', () => {
    const audit = makeAudit([deleted(2)]);
    const target = makeRecord({ name: 'fresh' });

    const result = restoreTo(audit, target, makeUlidGenerator(50));

    expect(result.entries[1]).toEqual({ type: AuditEntryType.Created, id: id(50), record: target });
  });

  it('makes the restored state live when replayed', () => {
    const audit = makeAudit([created(1), deleted(2), updated(3, 'edited-after-delete')]);

    const result = restoreTo(audit, makeRecord({ name: 'edited-after-delete' }), makeUlidGenerator());

    expect(createRecordFrom(result)).toEqual(makeRecord({ name: 'edited-after-delete' }));
  });
});

// ─── merge ────────────────────────────────────────────────────────────────────

describe('merge', () => {
  it('adopts the client audit when the server audit is not a valid document', () => {
    const clientAudit = makeAudit([created(1), updated(2, 'client')]);

    const result = merge(null as unknown as AuditOf<TestRecord>, clientAudit);

    expect(result).toBe(clientAudit);
  });

  it('logs an error when adopting the client audit over an invalid server document', () => {
    const { logger, error } = makeLogger();

    merge(null as unknown as AuditOf<TestRecord>, makeAudit([created(1)]), logger);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('server audit invalid document'), expect.objectContaining({ recordId: RECORD_ID }));
  });

  it('keeps the server audit when the client audit is not a valid document', () => {
    const serverAudit = makeAudit([created(1)]);

    const result = merge(serverAudit, { id: RECORD_ID } as unknown as AuditOf<TestRecord>);

    expect(result).toBe(serverAudit);
  });

  it('warns about both sides when neither audit is a valid document', () => {
    const { logger, warn } = makeLogger();

    merge('bad-server' as unknown as AuditOf<TestRecord>, 'bad-client' as unknown as AuditOf<TestRecord>, logger);

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      '[auditor] merge: server audit invalid document',
      '[auditor] merge: client audit invalid document',
    ]);
  });

  it('keeps the server entries when the client audit fails validation', () => {
    const serverAudit = makeAudit([created(1), updated(2, 'server')]);
    const clientAudit = makeAudit([branched(2), emptyUpdated(3)]);

    const result = merge(serverAudit, clientAudit);

    expect(result).toBe(serverAudit);
  });

  it('adopts the client entries when the server audit is empty and the client audit fails validation', () => {
    const clientEntries = [branched(1), emptyUpdated(2)];

    const result = merge(makeAudit([]), makeAudit(clientEntries));

    expect(result).toEqual(makeAudit(clientEntries));
  });

  it('keeps an invalid non-empty server audit rather than appending pending-only client entries to it', () => {
    const serverAudit = makeAudit([updated(1, 'orphan')]);

    const result = merge(serverAudit, makeAudit([updated(2, 'client')]));

    expect(result).toBe(serverAudit);
  });

  it('surfaces both rejection reasons when a pending-only client cannot fall back onto the server audit', () => {
    const { logger, warn } = makeLogger();

    merge(makeAudit([updated(1, 'orphan')]), makeAudit([updated(2, 'client')]), logger);

    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('orders merged entries by ULID regardless of which side they came from', () => {
    const serverAudit = makeAudit([created(1), updated(4, 'server-late')]);
    const clientAudit = makeAudit([created(1), updated(2, 'client-early'), updated(6, 'client-latest')]);

    const result = merge(serverAudit, clientAudit);

    expect(result.entries.map(entry => entry.id)).toEqual([id(1), id(2), id(4), id(6)]);
  });

  it('lets the highest ULID win when replaying the merged audit', () => {
    const serverAudit = makeAudit([created(1), updated(5, 'server-latest')]);
    const clientAudit = makeAudit([created(1), updated(3, 'client-older')]);

    const result = merge(serverAudit, clientAudit);

    expect(createRecordFrom(result)?.name).toBe('server-latest');
  });

  it('never imports Created or Branched entries from the client', () => {
    const serverAudit = makeAudit([created(1)]);
    const clientAudit = makeAudit([created(2, makeRecord({ name: 'client-created' })), branched(3), updated(4, 'x')]);

    const result = merge(serverAudit, clientAudit);

    expect(result.entries.map(entry => entry.type)).toEqual([AuditEntryType.Created, AuditEntryType.Updated]);
  });

  it('merges a sync-only client audit when full auditing is disabled', () => {
    const serverAudit = makeAudit([created(1)]);
    const clientAudit = makeAudit([branched(1), emptyUpdated(2)]);

    const result = merge(serverAudit, clientAudit, undefined, false);

    expect(result.entries.map(entry => entry.id)).toEqual([id(1), id(2)]);
  });
});

// ─── collapseToAnchor ─────────────────────────────────────────────────────────

describe('collapseToAnchor', () => {
  it('keeps only non-anchor entries newer than an anchor that is not in the local audit', () => {
    const audit = makeAudit([created(1), updated(3, 'synced'), branched(4), updated(7, 'pending')]);

    const result = collapseToAnchor(audit, id(5));

    expect(result.entries).toEqual([branched(5), updated(7, 'pending')]);
  });

  it('keeps entries inserted after a locally known anchor even when their ULID is lower', () => {
    const audit = makeAudit([created(1), updated(9, 'synced'), updated(8, 'pending-older-clock')]);

    const result = collapseToAnchor(audit, id(9));

    expect(result.entries).toEqual([branched(9), updated(8, 'pending-older-clock')]);
  });
});

// ─── Query helpers ────────────────────────────────────────────────────────────

describe('hasHistory', () => {
  const cases: [string, unknown, boolean][] = [
    ['an invalid document', null, false],
    ['only anchor entries', makeAudit([created(1), branched(2)]), false],
    ['an update after the anchor', makeAudit([created(1), updated(2, 'x')]), true],
    ['a delete after the anchor', makeAudit([branched(1), deleted(2)]), true],
  ];

  it.each(cases)('reports %s as having history=%s', (_label, audit, expected) => {
    expect(hasHistory(audit as AnyAuditOf<TestRecord>)).toBe(expected);
  });
});

describe('hasPendingChanges', () => {
  const cases: [string, unknown, boolean][] = [
    ['an invalid document', { id: 'r1' }, false],
    ['an empty audit', makeAudit([]), false],
    ['a never-synced audit (no anchor)', makeAudit([created(1)]), true],
    ['an anchor with nothing after it', makeAudit([branched(1)]), false],
    ['an anchor followed only by anchors', makeAudit([branched(1), branched(2), created(3)]), false],
    ['an anchor followed by an update', makeAudit([branched(1), updated(2, 'x')]), true],
    ['an anchor followed by a delete', makeAudit([branched(1), deleted(2)]), true],
  ];

  it.each(cases)('reports %s as pending=%s', (_label, audit, expected) => {
    expect(hasPendingChanges(audit as AnyAuditOf<TestRecord>)).toBe(expected);
  });
});

describe('isDeleted', () => {
  const cases: [string, unknown, boolean][] = [
    ['an invalid document', 42, false],
    ['a live audit', makeAudit([created(1), updated(2, 'x')]), false],
    ['a tombstoned audit', makeAudit([created(1), deleted(2)]), true],
    ['an update after a delete', makeAudit([created(1), deleted(2), updated(3, 'x')]), true],
    ['a restore after a delete', makeAudit([created(1), deleted(2), restored(3)]), false],
    ['a delete with a higher ULID inserted before a restore', makeAudit([created(1), deleted(5), restored(3)]), true],
    ['a restore with a higher ULID inserted before a delete', makeAudit([created(1), restored(5), deleted(3)]), false],
  ];

  it.each(cases)('reports %s as deleted=%s', (_label, audit, expected) => {
    expect(isDeleted(audit as AnyAuditOf<TestRecord>)).toBe(expected);
  });
});

describe('isBranchOnly', () => {
  const cases: [string, unknown, boolean][] = [
    ['an invalid document', undefined, false],
    ['a lone anchor', makeAudit([branched(1)]), true],
    ['a Created entry', makeAudit([created(1)]), true],
    ['an anchor with a pending update', makeAudit([branched(1), updated(2, 'x')]), false],
  ];

  it.each(cases)('reports %s as branch-only=%s', (_label, audit, expected) => {
    expect(isBranchOnly(audit as AnyAuditOf<TestRecord>)).toBe(expected);
  });
});

describe('getBranchUlid', () => {
  it('returns the id of the Branched anchor', () => {
    expect(getBranchUlid(makeAudit([branched(3), updated(4, 'x')]))).toBe(id(3));
  });

  it('returns undefined when there is no anchor', () => {
    expect(getBranchUlid(makeAudit([created(1)]))).toBeUndefined();
  });
});

describe('getLastEntryId', () => {
  it('returns the highest ULID even when it is not the last inserted entry', () => {
    expect(getLastEntryId(makeAudit([created(1), updated(7, 'x'), updated(4, 'y')]))).toBe(id(7));
  });

  it('returns undefined for an audit with no entries', () => {
    expect(getLastEntryId(makeAudit([]))).toBeUndefined();
  });
});

describe('getLastEntryTimestamp', () => {
  const EARLIER_MS = 1_700_000_000_000;
  const LATER_MS = 1_700_000_050_000;

  it('decodes the timestamp of the latest ULID', () => {
    const audit = makeAudit([
      { type: AuditEntryType.Created, id: ulid(EARLIER_MS), record: makeRecord() },
      { type: AuditEntryType.Deleted, id: ulid(LATER_MS) },
    ]);

    expect(getLastEntryTimestamp(audit)).toBe(LATER_MS);
  });

  it('returns undefined for an audit with no entries', () => {
    expect(getLastEntryTimestamp(makeAudit([]))).toBeUndefined();
  });

  it('returns undefined when the latest entry id is not a decodable ULID', () => {
    expect(getLastEntryTimestamp(makeAudit([{ type: AuditEntryType.Deleted, id: 'not-a-ulid' }]))).toBeUndefined();
  });
});

// ─── rebaseRecord ─────────────────────────────────────────────────────────────

describe('rebaseRecord', () => {
  it('returns the new server record untouched when the user made no local edits', () => {
    const oldServer = makeRecord();
    const newServer = makeRecord({ name: 'server-changed' });

    expect(rebaseRecord(oldServer, makeRecord(), newServer)).toBe(newServer);
  });

  it('lets the local edit win over a concurrent server edit of the same field', () => {
    const oldServer = makeRecord();
    const userRecord = makeRecord({ name: 'user' });
    const newServer = makeRecord({ name: 'server' });

    expect(rebaseRecord(oldServer, userRecord, newServer).name).toBe('user');
  });
});

// ─── createBranchFrom ─────────────────────────────────────────────────────────

describe('createBranchFrom', () => {
  it('creates an audit holding only a Branched anchor at the last synced entry', () => {
    expect(createBranchFrom('r9', id(4))).toEqual({ id: 'r9', entries: [{ type: AuditEntryType.Branched, id: id(4) }] });
  });

  it('creates an audit with no pending changes', () => {
    expect(hasPendingChanges(createBranchFrom(RECORD_ID, id(4)))).toBe(false);
  });
});
