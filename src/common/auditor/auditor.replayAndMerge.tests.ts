import { describe, it, expect, afterEach } from 'vitest';
import type { Record as MXDBRecord } from '@anupheaus/common';
import {
  auditor,
  AuditEntryType,
  type AuditEntry,
  type AuditOf,
  type AuditCreatedEntry,
  type AuditUpdateEntry,
  type AuditDeletedEntry,
  type AuditRestoredEntry,
} from '..';
import { recordDiff } from './diff';
import { replayHistoryEndState } from './replay';

type TestRecord = MXDBRecord & { name?: string; value?: number; phase?: string };

afterEach(() => {
  auditor.setClockDrift(0);
});

/**
 * Distinct ULIDs in ascending lex order (matches replay / merge sort order).
 * We generate in bulk then sort — stepping `setClockDrift` upward actually makes ULIDs
 * encode *older* times, which reverses string order and breaks "generation order === sort order".
 */
function orderedUlids(count: number): string[] {
  auditor.setClockDrift(0);
  const ids = Array.from({ length: count }, () => auditor.generateUlid());
  ids.sort();
  for (let i = 1; i < ids.length; i++) {
    expect(ids[i]! > ids[i - 1]!).toBe(true);
  }
  return ids;
}

function cloneRecord(r: TestRecord): TestRecord {
  return { ...r };
}

/**
 * Linear audit: Created(s0) then Updated transitions s0→s1→…→s_{n-1}.
 * `ids.length` must equal `states.length` (one id per entry).
 */
function linearAudit(recordId: string, states: TestRecord[], ids: string[]): AuditOf<TestRecord> {
  if (states.length < 1) throw new Error('need at least one state');
  if (ids.length !== states.length) throw new Error('ids.length must match states.length');

  const created: AuditCreatedEntry<TestRecord> = {
    type: AuditEntryType.Created,
    id: ids[0]!,
    record: cloneRecord(states[0]!),
  };

  const updates: AuditUpdateEntry[] = [];
  for (let i = 0; i < states.length - 1; i++) {
    updates.push({
      type: AuditEntryType.Updated,
      id: ids[i + 1]!,
      ops: recordDiff(states[i]!, states[i + 1]!),
    });
  }

  return { id: recordId, entries: [created, ...updates] };
}

function expectReplayMatches(audit: AuditOf<TestRecord>, expected: TestRecord): void {
  const got = auditor.createRecordFrom(audit);
  expect(got).toBeDefined();
  expect(got).toMatchObject(expected);
}

describe('auditor replay — real-world lifecycles', () => {
  it('replays create → many sequential updates → matches final record', () => {
    let r = { id: 'doc-a', name: 'v0', value: 0 } as TestRecord;
    let audit = auditor.createAuditFrom(r);

    for (let i = 1; i <= 20; i++) {
      r = { ...r, name: `v${i}`, value: i };
      audit = auditor.updateAuditWith(r, audit);
    }

    expectReplayMatches(audit, { id: 'doc-a', name: 'v20', value: 20 });
    expect(audit.entries.length).toBe(21);
  });

  it('replays create → updates → delete → undefined', () => {
    let audit = auditor.createAuditFrom({ id: 'doc-b', name: 'a', value: 1 } as TestRecord);
    audit = auditor.updateAuditWith({ id: 'doc-b', name: 'b', value: 2 } as TestRecord, audit);
    audit = auditor.updateAuditWith({ id: 'doc-b', name: 'c', value: 3 } as TestRecord, audit);
    audit = auditor.delete(audit);

    expect(auditor.isDeleted(audit)).toBe(true);
    expect(auditor.createRecordFrom(audit)).toBeUndefined();
  });

  it('replays create → updates → delete → restore → more updates', () => {
    let audit = auditor.createAuditFrom({ id: 'doc-c', name: 's0', value: 0 } as TestRecord);
    audit = auditor.updateAuditWith({ id: 'doc-c', name: 's1', value: 10 } as TestRecord, audit);
    audit = auditor.updateAuditWith({ id: 'doc-c', name: 's2', value: 20 } as TestRecord, audit);
    audit = auditor.delete(audit);
    expect(auditor.createRecordFrom(audit)).toBeUndefined();

    const afterRestore = { id: 'doc-c', name: 'fresh', value: 100, phase: 'post-delete' } as TestRecord;
    audit = auditor.restoreTo(audit, afterRestore);
    expect(auditor.isDeleted(audit)).toBe(false);
    expectReplayMatches(audit, afterRestore);

    audit = auditor.updateAuditWith({ id: 'doc-c', name: 'fresh', value: 101, phase: 'post-delete' } as TestRecord, audit);
    audit = auditor.updateAuditWith({ id: 'doc-c', name: 'done', value: 102, phase: 'final' } as TestRecord, audit);

    expectReplayMatches(audit, { id: 'doc-c', name: 'done', value: 102, phase: 'final' });
  });

  it('update after delete does not restore live — delete is final', () => {
    // Build a hand-crafted entries array: Created → Updated → Deleted → Updated (post-delete)
    // All ULIDs must be in strictly ascending lex order so the replay sorts them correctly.
    const ids = orderedUlids(4);
    const s0 = { id: 'doc-final', name: 'original', value: 0 } as TestRecord;
    const s1 = { id: 'doc-final', name: 'updated', value: 1 } as TestRecord;
    // The post-delete update bumps `name` to 'post-delete' — this must advance shadow but NOT restore live.
    const s2 = { id: 'doc-final', name: 'post-delete', value: 2 } as TestRecord;

    const created: AuditCreatedEntry<TestRecord> = {
      type: AuditEntryType.Created,
      id: ids[0]!,
      record: cloneRecord(s0),
    };
    const updated: AuditUpdateEntry = {
      type: AuditEntryType.Updated,
      id: ids[1]!,
      ops: recordDiff(s0, s1),
    };
    const deleted: AuditDeletedEntry = { type: AuditEntryType.Deleted, id: ids[2]! };
    const postDeleteUpdate: AuditUpdateEntry = {
      type: AuditEntryType.Updated,
      id: ids[3]!,
      ops: recordDiff(s1, s2),
    };

    const entries = [created, updated, deleted, postDeleteUpdate] as AuditEntry<TestRecord>[];
    const audit: AuditOf<TestRecord> = { id: 'doc-final', entries };

    // live must be tombstoned — the post-delete update must NOT resurrect it
    expect(auditor.createRecordFrom(audit)).toBeUndefined();
    expect(auditor.isDeleted(audit)).toBe(true);

    // shadow must have advanced: the post-delete update is applied to shadow
    const { shadow } = replayHistoryEndState<TestRecord>(entries, undefined);
    expect(shadow).toBeDefined();
    expect(shadow!.name).toBe('post-delete');
  });

  it('replays alternating field edits (name vs value) without cross-talk', () => {
    let audit = auditor.createAuditFrom({ id: 'doc-d', name: 'n0', value: 0 } as TestRecord);
    for (let i = 1; i <= 15; i++) {
      const base = auditor.createRecordFrom(audit)!;
      const next =
        i % 2 === 1
          ? ({ ...base, name: `n${i}` } as TestRecord)
          : ({ ...base, value: i * 7 } as TestRecord);
      audit = auditor.updateAuditWith(next, audit);
    }
    const final = auditor.createRecordFrom(audit);
    expect(final?.id).toBe('doc-d');
    expect(final?.name).toBe('n15');
    expect(final?.value).toBe(14 * 7);
  });

  it('replays a long chain built from explicit diffs (sanity vs updateAuditWith)', () => {
    const states: TestRecord[] = [];
    for (let i = 0; i < 12; i++) {
      states.push({ id: 'doc-e', name: `step-${i}`, value: i * 3 } as TestRecord);
    }
    const ids = orderedUlids(states.length);
    const audit = linearAudit('doc-e', states, ids);
    expectReplayMatches(audit, states[states.length - 1]!);
  });
});

describe('auditor merge — batched / shuffled ULID order', () => {
  it('merges sequential client batches when all new ULIDs are after server tail', () => {
    const states: TestRecord[] = [];
    for (let i = 0; i < 8; i++) {
      states.push({ id: 'rec-1', name: `b${i}`, value: i } as TestRecord);
    }
    const ids = orderedUlids(states.length);
    const full = linearAudit('rec-1', states, ids);

    const cut = 3;
    const serverEntries = full.entries.slice(0, cut);
    const batchA = full.entries.slice(cut, cut + 2);
    const batchB = full.entries.slice(cut + 2);

    let server: AuditOf<TestRecord> = { id: 'rec-1', entries: serverEntries };

    const pendingA: AuditOf<TestRecord> = {
      id: 'rec-1',
      entries: batchA.filter(e => e.type !== AuditEntryType.Created),
    };
    const pendingB: AuditOf<TestRecord> = {
      id: 'rec-1',
      entries: batchB.filter(e => e.type !== AuditEntryType.Created),
    };

    server = auditor.merge(server, pendingA);
    server = auditor.merge(server, pendingB);

    const sortedFull = [...full.entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const sortedMerged = [...server.entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(sortedMerged.map(e => e.id)).toEqual(sortedFull.map(e => e.id));

    expectReplayMatches(server, states[states.length - 1]!);
  });

  it('merges interleaved partitions: server and clients each hold a subset; sort restores linear replay', () => {
    const n = 7;
    const states: TestRecord[] = Array.from({ length: n }, (_, i) => ({
      id: 'rec-2',
      name: `p${i}`,
      value: i * 11,
    })) as TestRecord[];

    const ids = orderedUlids(n);
    const entries = linearAudit('rec-2', states, ids).entries;

    const E = entries;
    const serverPart = [E[0]!, E[3]!, E[6]!] as AuditEntry<TestRecord>[];
    const clientBatch1 = [E[1]!, E[4]!] as AuditEntry<TestRecord>[];
    const clientBatch2 = [E[2]!, E[5]!] as AuditEntry<TestRecord>[];

    let server: AuditOf<TestRecord> = { id: 'rec-2', entries: serverPart };

    for (const batch of [clientBatch1, clientBatch2]) {
      const pending: AuditOf<TestRecord> = {
        id: 'rec-2',
        entries: batch.filter(e => e.type !== AuditEntryType.Created),
      };
      server = auditor.merge(server, pending);
    }

    const sortedMerged = [...server.entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(sortedMerged.map(e => e.id)).toEqual(entries.map(e => e.id));

    expectReplayMatches(server, states[n - 1]!);
  });

  it('merges three small pending batches out of ULID order into a Created head', () => {
    const states: TestRecord[] = [
      { id: 'rec-3', name: 'x', value: 0 },
      { id: 'rec-3', name: 'x', value: 1 },
      { id: 'rec-3', name: 'x', value: 2 },
      { id: 'rec-3', name: 'x', value: 3 },
      { id: 'rec-3', name: 'y', value: 3 },
    ] as TestRecord[];
    const ids = orderedUlids(states.length);
    const entries = linearAudit('rec-3', states, ids).entries;

    const server: AuditOf<TestRecord> = { id: 'rec-3', entries: [entries[0]!] };
    const batches = [[entries[3]!, entries[1]!], [entries[4]!], [entries[2]!]];

    let merged = server;
    for (const raw of batches) {
      const pending: AuditOf<TestRecord> = {
        id: 'rec-3',
        entries: raw.map(e => e as AuditUpdateEntry),
      };
      merged = auditor.merge(merged, pending);
    }

    expectReplayMatches(merged, states[states.length - 1]!);
  });

  it('merge + replay with delete and restore entries in shuffled batches', () => {
    const ids = orderedUlids(5);
    const s0 = { id: 'rec-4', name: 'a', value: 0 } as TestRecord;
    const s1 = { id: 'rec-4', name: 'b', value: 1 } as TestRecord;
    const s2 = { id: 'rec-4', name: 'c', value: 2 } as TestRecord;
    const afterRestore = { id: 'rec-4', name: 'c', value: 100 } as TestRecord;

    const created: AuditCreatedEntry<TestRecord> = {
      type: AuditEntryType.Created,
      id: ids[0]!,
      record: cloneRecord(s0),
    };
    const u1: AuditUpdateEntry = {
      type: AuditEntryType.Updated,
      id: ids[1]!,
      ops: recordDiff(s0, s1),
    };
    const u2: AuditUpdateEntry = {
      type: AuditEntryType.Updated,
      id: ids[2]!,
      ops: recordDiff(s1, s2),
    };
    const del: AuditDeletedEntry = { type: AuditEntryType.Deleted, id: ids[3]! };
    const rest: AuditRestoredEntry<TestRecord> = {
      type: AuditEntryType.Restored,
      id: ids[4]!,
      record: cloneRecord(afterRestore),
    };

    const ordered = [created, u1, u2, del, rest];

    let server: AuditOf<TestRecord> = { id: 'rec-4', entries: [created, del, rest] };
    const pending1: AuditOf<TestRecord> = { id: 'rec-4', entries: [u1] };
    const pending2: AuditOf<TestRecord> = { id: 'rec-4', entries: [u2] };

    server = auditor.merge(server, pending1);
    server = auditor.merge(server, pending2);

    const sortedMerged = [...server.entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(sortedMerged.map(e => e.id)).toEqual(ordered.map(e => e.id));

    expect(auditor.createRecordFrom(server)).toMatchObject({ id: 'rec-4', value: 100 });
  });

  it('Restored with record uses snapshot; without record copies shadow after delete', () => {
    const ids = orderedUlids(6);
    const s0 = { id: 'rec-5', name: 'a', value: 0 } as TestRecord;
    const s1 = { id: 'rec-5', name: 'b', value: 1 } as TestRecord;
    const snapshot = { id: 'rec-5', name: 'snapshot', value: 50 } as TestRecord;

    const withPayload: AuditOf<TestRecord> = {
      id: 'rec-5',
      entries: [
        { type: AuditEntryType.Created, id: ids[0]!, record: cloneRecord(s0) },
        { type: AuditEntryType.Updated, id: ids[1]!, ops: recordDiff(s0, s1) },
        { type: AuditEntryType.Deleted, id: ids[2]! },
        { type: AuditEntryType.Restored, id: ids[3]!, record: cloneRecord(snapshot) },
        { type: AuditEntryType.Updated, id: ids[4]!, ops: recordDiff(snapshot, { ...snapshot, value: 51 }) },
      ],
    };
    expect(auditor.createRecordFrom(withPayload)).toMatchObject({ name: 'snapshot', value: 51 });

    const fromShadow: AuditOf<TestRecord> = {
      id: 'rec-5',
      entries: [
        { type: AuditEntryType.Created, id: ids[0]!, record: cloneRecord(s0) },
        { type: AuditEntryType.Updated, id: ids[1]!, ops: recordDiff(s0, s1) },
        { type: AuditEntryType.Deleted, id: ids[2]! },
        { type: AuditEntryType.Restored, id: ids[3]! },
        { type: AuditEntryType.Updated, id: ids[4]!, ops: recordDiff(s1, { ...s1, value: 2 }) },
      ],
    };
    expect(auditor.createRecordFrom(fromShadow)).toMatchObject({ name: 'b', value: 2 });
  });
});
