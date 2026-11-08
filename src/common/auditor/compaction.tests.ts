import { describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import type { Record as MXDBRecord } from '@anupheaus/common';
import { AuditEntryType, OperationType, type AuditCreatedEntry, type AuditEntry, type AuditOf, type AuditOperation, type AuditUpdateEntry } from './auditor-models';
import { AUDIT_COMPACTION_LIMITS, compactAuditEntries, type AuditCompactionLimits } from './compaction';
import { MAX_AUDIT_PATH_CLOCKS } from './pathClocks';
import { merge, isDeleted } from './api';
import { replayHistory, replayHistoryEndState } from './replay';

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface TestRecord extends MXDBRecord {
  a?: { x?: number; y?: number };
  b?: number;
  c?: { d?: number };
  text?: string;
  list?: { id: string }[];
}

const RECORD_ID = 'r1';
const BASE_TIME = Date.UTC(2026, 0, 1);
/** Entry ids in time order: entry n was made n * 10 ms after the record was created. */
const idAt = (step: number): string => ulid(BASE_TIME + step * 10, () => 0);
const SMALL_LIMITS: AuditCompactionLimits = { maxEntries: 6, maxCharacters: 1_000_000, retainedEntries: 3, retainedCharacters: 1_000_000 };

const created = (record: TestRecord = { id: RECORD_ID, a: { x: 0, y: 0 }, b: 0, c: { d: 0 } }): AuditCreatedEntry<TestRecord> => ({ type: AuditEntryType.Created, id: idAt(0), record });
const update = (step: number, ...ops: AuditOperation[]): AuditUpdateEntry => ({ type: AuditEntryType.Updated, id: idAt(step), ops });
const replace = (path: string, value: unknown): AuditOperation => ({ type: OperationType.Replace, path, value });
const remove = (path: string): AuditOperation => ({ type: OperationType.Remove, path });
const auditOf = (entries: AuditEntry<TestRecord>[]): AuditOf<TestRecord> => ({ id: RECORD_ID, entries });

/** A small deterministic random generator (mulberry32), so every run explores the same histories. */
function randomFrom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One random change: whole objects, their fields, removals — so writes cover, and are covered by, each other. */
function randomOp(random: () => number): AuditOperation {
  const value = Math.floor(random() * 1_000);
  const choices: AuditOperation[] = [
    replace('a', { x: value, y: value + 1 }),
    replace('a.x', value),
    replace('a.y', value),
    remove('a.x'),
    remove('a'),
    replace('b', value),
    remove('b'),
    replace('c', { d: value }),
    replace('c.d', value),
  ];
  return choices[Math.floor(random() * choices.length)]!;
}

/** The record as the full, never-compacted history gives it: the reference every compacted audit must match. */
const referenceRecord = (entries: AuditEntry<TestRecord>[], base = created()): TestRecord | undefined => replayHistory([base, ...entries], undefined);

/** The server's audit after each arriving entry is merged in and the audit compacted, as `ServerDbCollection` stores it. */
function serverAfter(arrivals: AuditEntry<TestRecord>[], limits: AuditCompactionLimits, base = created()): { audit: AuditOf<TestRecord>; largestEntryCount: number } {
  let audit = auditOf([base]);
  let largestEntryCount = 1;
  for (const arrival of arrivals) {
    const merged = merge(audit, auditOf([arrival])) as AuditOf<TestRecord>;
    audit = auditOf(compactAuditEntries(merged.entries, limits)?.entries ?? merged.entries);
    largestEntryCount = Math.max(largestEntryCount, audit.entries.length);
  }
  return { audit, largestEntryCount };
}

// ─── Compaction ──────────────────────────────────────────────────────────────

describe('compactAuditEntries', () => {
  it('leaves an audit within the limits alone', () => {
    expect(compactAuditEntries([created(), update(1, replace('b', 1))], SMALL_LIMITS)).toBeUndefined();
  });

  it('folds the oldest entries into one Created snapshot that replays to the same record', () => {
    const entries = [created(), ...Array.from({ length: 9 }, (_, index) => update(index + 1, replace('b', index + 1)))];
    const result = compactAuditEntries(entries, SMALL_LIMITS)!;

    expect(result.entries.map(({ type, id }) => [type, id])).toEqual([
      [AuditEntryType.Created, idAt(6)],
      [AuditEntryType.Updated, idAt(7)], [AuditEntryType.Updated, idAt(8)], [AuditEntryType.Updated, idAt(9)],
    ]);
    expect(replayHistory(result.entries, undefined)).toEqual(replayHistory(entries, undefined));
    expect((result.entries[0] as AuditCreatedEntry).compaction).toEqual({ historyStart: idAt(0), clocks: [{ path: 'b', id: idAt(6) }] });
    expect(result.folded.map(({ id }) => id)).toEqual(entries.slice(0, 7).map(({ id }) => id));
  });

  it('compacts by size too, keeping no more than the retained characters as entries', () => {
    const longText = 'x'.repeat(4_000);
    const entries = [created(), ...Array.from({ length: 10 }, (_, index) => update(index + 1, replace('text', `${index}${longText}`)))];
    const limits: AuditCompactionLimits = { maxEntries: 100, maxCharacters: 20_000, retainedEntries: 100, retainedCharacters: 10_000 };
    const result = compactAuditEntries(entries, limits)!;

    expect(result.entries.slice(1).reduce((total, entry) => total + JSON.stringify(entry).length, 0)).toBeLessThanOrEqual(10_000);
    expect(replayHistory(result.entries, undefined)).toEqual(replayHistory(entries, undefined));
  });

  it('never folds from a Deleted entry on', () => {
    const entries: AuditEntry<TestRecord>[] = [
      created(), update(1, replace('b', 1)), update(2, replace('b', 2)), { type: AuditEntryType.Deleted, id: idAt(3) },
      ...Array.from({ length: 6 }, (_, index) => update(index + 4, replace('b', index + 4))),
    ];
    const result = compactAuditEntries(entries, SMALL_LIMITS)!;

    expect(result.entries.map(({ type }) => type)).toEqual([AuditEntryType.Created, AuditEntryType.Deleted, ...Array(6).fill(AuditEntryType.Updated)]);
    expect(isDeleted(auditOf(result.entries))).toBe(true);
  });

  it('does nothing for an audit that does not start with Created', () => {
    const entries: AuditEntry<TestRecord>[] = Array.from({ length: 9 }, (_, index) => update(index + 1, replace('b', index)));
    expect(compactAuditEntries(entries, SMALL_LIMITS)).toBeUndefined();
  });

  it('keeps the start of the history and the clocks when it compacts an already compacted audit', () => {
    const first = compactAuditEntries([created(), ...Array.from({ length: 9 }, (_, index) => update(index + 1, replace('b', index + 1)))], SMALL_LIMITS)!;
    const second = compactAuditEntries([...first.entries, update(10, replace('a.x', 10)), update(11, replace('a.x', 11)), update(12, replace('c.d', 12)), update(13, replace('b', 13))], SMALL_LIMITS)!;

    expect((second.entries[0] as AuditCreatedEntry).compaction).toEqual({ historyStart: idAt(0), clocks: [{ path: 'b', id: idAt(9) }, { path: 'a.x', id: idAt(10) }] });
  });

  it('keeps the default audit far below MongoDB\'s 16 MB however often a record with a 4,000-character text is written', () => {
    let entries: AuditEntry<TestRecord>[] = [created()];
    let largest = 0;
    for (let step = 1; step <= 1_200; step += 1) {
      const text = step % 2 === 0 ? `${step}${'p'.repeat(4_000)}` : 'fitted';
      entries = compactAuditEntries([...entries, update(step, replace('text', text))])?.entries ?? [...entries, update(step, replace('text', text))];
      largest = Math.max(largest, JSON.stringify(entries).length);
    }
    expect([entries.length <= AUDIT_COMPACTION_LIMITS.maxEntries, largest <= AUDIT_COMPACTION_LIMITS.maxCharacters + 10_000]).toEqual([true, true]);
  });
});

// ─── Merging into a compacted audit ──────────────────────────────────────────

describe('merge into a compacted audit', () => {
  /** A server audit compacted once: entries 1–9 written to `b`, so the snapshot covers 1–6 and 7–9 are kept. */
  const compacted = (): AuditOf<TestRecord> => auditOf(compactAuditEntries([created(), ...Array.from({ length: 9 }, (_, index) => update(index * 10 + 10, replace('b', index + 1)))], SMALL_LIMITS)!.entries);

  it.each([
    ['older than the snapshot and every write to its path: folded in, and lost to the newer ones (last-write-wins)', update(5, replace('b', 99)), { b: 9 }, 0],
    ['older than the snapshot, to a path no folded entry wrote: folded in and applied', update(5, replace('a.x', 99)), { a: { x: 99, y: 0 }, b: 9 }, 0],
    ['newer than the snapshot but older than the kept writes to its path: kept as an entry, and lost to them', update(65, replace('b', 99)), { b: 9 }, 1],
  ])('an entry %s', (_label, late, expected, addedEntries) => {
    const merged = merge(compacted(), auditOf([late])) as AuditOf<TestRecord>;
    expect(replayHistory(merged.entries, undefined)).toMatchObject(expected);
    expect(merged.entries).toHaveLength(compacted().entries.length + addedEntries);
  });

  it('applies an older entry to a path only kept entries wrote later, under them', () => {
    const writes = [
      ...Array.from({ length: 6 }, (_, index) => update(index * 10 + 10, replace('b', index + 1))),
      update(70, replace('a.y', 7)), update(80, replace('a.y', 8)), update(90, replace('a.y', 9)),
    ];
    const audit = auditOf(compactAuditEntries([created(), ...writes], SMALL_LIMITS)!.entries);
    const merged = merge(audit, auditOf([update(5, replace('a', { x: 50, y: 50 }))])) as AuditOf<TestRecord>;
    expect(replayHistory(merged.entries, undefined)).toMatchObject({ a: { x: 50, y: 9 }, b: 6 });
  });

  it('keeps a newer change inside a path when an older change replaces the whole path', () => {
    const audit = auditOf(compactAuditEntries([created(), update(10, replace('a.x', 1)), ...Array.from({ length: 8 }, (_, index) => update(index * 10 + 20, replace('b', index)))], SMALL_LIMITS)!.entries);
    const merged = merge(audit, auditOf([update(5, replace('a', { x: 50, y: 50 }))])) as AuditOf<TestRecord>;
    expect(replayHistory(merged.entries, undefined)).toMatchObject({ a: { x: 1, y: 50 } });
  });

  it('changes nothing when a device resends entries already folded into the snapshot', () => {
    const entries = [created(), update(10, replace('a', { x: 1, y: 1 })), update(20, replace('a.x', 2)), ...Array.from({ length: 7 }, (_, index) => update(index * 10 + 30, replace('b', index)))];
    const audit = auditOf(compactAuditEntries(entries, SMALL_LIMITS)!.entries);
    const merged = merge(audit, auditOf(entries.slice(1, 4))) as AuditOf<TestRecord>;
    expect(merged.entries).toEqual(audit.entries);
  });

  it('drops an entry older than the start of the history, as after an audit reset', () => {
    const reset = auditOf(compactAuditEntries([{ ...created(), id: idAt(5) }, ...Array.from({ length: 9 }, (_, index) => update(index * 10 + 10, replace('b', index + 1)))], SMALL_LIMITS)!.entries);
    const merged = merge(reset, auditOf([update(1, replace('a.x', 99))])) as AuditOf<TestRecord>;
    expect(replayHistory(merged.entries, undefined)).toMatchObject({ a: { x: 0 } });
  });

  it('ends deleted when a device\'s older delete arrives after the compaction', () => {
    const merged = merge(compacted(), auditOf([{ type: AuditEntryType.Deleted, id: idAt(5) }]));
    expect([isDeleted(merged), replayHistory(merged.entries, undefined)]).toEqual([true, undefined]);
  });

  it('does not add a second delete to a record already deleted', () => {
    const deleted = merge(compacted(), auditOf([{ type: AuditEntryType.Deleted, id: idAt(500) }]));
    const again = merge(deleted, auditOf([{ type: AuditEntryType.Deleted, id: idAt(5) }]));
    expect(again.entries).toHaveLength(deleted.entries.length);
  });

  // The whole space, every ordering: entries arrive late, early, twice; the audit is compacted after every write. The record
  // must always be what the full history gives — computed separately by replaying every entry, never compacted.
  it.each(Array.from({ length: 60 }, (_, seed) => seed))('matches the full history for random histories and arrival orders (seed %i)', seed => {
    const random = randomFrom(seed + 1);
    const writes = Array.from({ length: 40 }, (_, index) => update(index + 1, ...Array.from({ length: 1 + Math.floor(random() * 2) }, () => randomOp(random))));
    // Most entries arrive in order; some are held back (a device offline) and some sent twice (a resend).
    const onTime = writes.filter(() => random() > 0.3);
    const held = writes.filter(write => !onTime.includes(write));
    const arrivals = [...onTime];
    for (const late of held) arrivals.splice(Math.floor(random() * (arrivals.length + 1)) + Math.floor(random() * 5), 0, late);
    const resent = arrivals.filter(() => random() < 0.15);
    const withResends = [...arrivals, ...resent];

    const { audit, largestEntryCount } = serverAfter(withResends, SMALL_LIMITS);

    expect(replayHistory(audit.entries, undefined)).toEqual(referenceRecord(writes));
    expect(largestEntryCount).toBeLessThanOrEqual(SMALL_LIMITS.maxEntries + 1);
  });

  it('matches the full history when the newest-first arrival puts every entry before the snapshot', () => {
    const random = randomFrom(99);
    const writes = Array.from({ length: 30 }, (_, index) => update(index + 1, randomOp(random), randomOp(random)));
    const { audit } = serverAfter([...writes.slice(15), ...writes.slice(0, 15).reverse()], SMALL_LIMITS);
    expect(replayHistory(audit.entries, undefined)).toEqual(referenceRecord(writes));
  });
});

// ─── More distinct paths than the clocks can hold (sc-4409 QA round 1) ───────

describe('merge into a compacted audit whose record has had more paths written than the clocks hold', () => {
  const withList = (): AuditCreatedEntry<TestRecord> => created({ id: RECORD_ID, a: { x: 0, y: 0 }, b: 0, c: { d: 0 }, list: [] });
  const addItem = (step: number): AuditUpdateEntry => update(step, { type: OperationType.Add, path: `list.[id:m${step}]`, value: { id: `m${step}` } });
  /** An offline device's edit made before everything else, arriving last. */
  const offlineEdit = update(1, replace('a.x', 99));

  it('merges an offline edit to an untouched field after 700 items were added to a list (legitimate churn)', () => {
    const churn = Array.from({ length: 700 }, (_, index) => addItem(index + 2));
    const { audit } = serverAfter([...churn, offlineEdit], AUDIT_COMPACTION_LIMITS, withList());
    const record = replayHistory(audit.entries, undefined);
    expect(record?.a).toEqual({ x: 99, y: 0 });
    expect(record).toEqual(referenceRecord([offlineEdit, ...churn], withList()));
  });

  it('merges an offline edit to an untouched field after one write crafted with 600 junk paths (hostile)', () => {
    const junk = update(2, ...Array.from({ length: 600 }, (_, index) => replace(`junk${index}.x`, 1)));
    const ordinary = Array.from({ length: 60 }, (_, index) => update(index + 3, replace('b', index)));
    const { audit } = serverAfter([junk, ...ordinary, offlineEdit], AUDIT_COMPACTION_LIMITS);
    const record = replayHistory(audit.entries, undefined);
    expect(record?.a).toEqual({ x: 99, y: 0 });
    expect(record).toEqual(referenceRecord([offlineEdit, junk, ...ordinary]));
  });

  // The whole space for a high fan-out record: more than 500 distinct paths written (items added to a list), with ordinary
  // writes elsewhere held back, arriving late and resent. A late write outside the churned list must always land, and the
  // audit must replay to exactly what the full, never-compacted history gives.
  it.each(Array.from({ length: 8 }, (_, seed) => seed))('matches the full history with more than 500 distinct paths (seed %i)', seed => {
    const random = randomFrom(seed + 1_000);
    // Early on, a few edits to `text`, which nothing else writes: all of them are held back until the end.
    const offlineSteps = new Set(Array.from({ length: 3 }, () => 1 + Math.floor(random() * 60)));
    const writes = Array.from({ length: 700 }, (_, index) => {
      const step = index + 1;
      if (offlineSteps.has(step)) return update(step, replace('text', `offline ${step}`));
      return random() < 0.08 ? update(step, randomOp(random)) : addItem(step);
    });
    const ordinary = writes.filter(write => !write.ops.some(({ path }) => path.startsWith('list')));
    const held = ordinary.filter(write => offlineSteps.has(writes.indexOf(write) + 1) || random() < 0.5);
    const arrivals = [...writes.filter(write => !held.includes(write)), ...held.reverse(), ...ordinary.filter(() => random() < 0.2)];

    const { audit } = serverAfter(arrivals, AUDIT_COMPACTION_LIMITS, withList());

    expect(replayHistory(audit.entries, undefined)).toEqual(referenceRecord(writes, withList()));
  });
});

// ─── Cost of one huge write (sc-4409 QA round 2) ─────────────────────────────

describe('one write with a huge number of ops', () => {
  const OPS = 50_000;
  /** Well under a second here; the quadratic fold took 8.5 s for 20,000 ops and 36 s for 30,000. */
  const BUDGET_MS = 1_500;
  // Few ordinary writes and small entry limits (the clock limits stay the defaults): the reference replays below clone the
  // huge record once per entry, so fewer entries keep the test quick without changing what is measured.
  const ordinary = Array.from({ length: 8 }, (_, index) => update(index + 3, replace('b', index)));
  const timed = <T>(run: () => T): { result: T; elapsedMs: number } => {
    const start = performance.now();
    const result = run();
    return { result, elapsedMs: performance.now() - start };
  };

  const addItem = (index: number): AuditOperation => ({ type: OperationType.Add, path: `list.[id:v${index}]`, value: { id: `v${index}` } });

  // Distinct valid paths are items added to a list, not keys added to one object: `to.serialise`/`to.deserialise` in
  // @anupheaus/common rebuild an object key by key (quadratic in its keys), which every replay already pays, before and
  // after this change. That is a separate defect in common, raised on the epic.
  it.each([
    ['junk paths that lead nowhere', (index: number) => replace(`j${index}.q`, 1)],
    ['distinct valid paths (items added to a list)', addItem],
  ])('is merged and compacted in linear time: %s', (_label, opAt) => {
    const base = created({ id: RECORD_ID, a: { x: 0, y: 0 }, b: 0, c: { d: 0 }, list: [] });
    const huge = update(2, ...Array.from({ length: OPS }, (_, index) => opAt(index)));
    const offlineEdit = update(1, replace('a.x', 99));

    // The write arrives and the audit is compacted with it among the folded entries: the step that was quadratic.
    const { result: { merged, compacted }, elapsedMs } = timed(() => {
      const mergedAudit = merge(auditOf([base, ...ordinary]), auditOf([huge])) as AuditOf<TestRecord>;
      return { merged: mergedAudit, compacted: compactAuditEntries(mergedAudit.entries, SMALL_LIMITS)! };
    });
    // Within the budget, or (for a write that makes the record itself huge) no slower than the replay of the same audit that
    // ServerReceiver already does on every write: that replay clones the record once per entry, before and after this change.
    const { elapsedMs: replayMs } = timed(() => replayHistoryEndState(merged.entries, undefined));
    expect(elapsedMs).toBeLessThan(Math.max(BUDGET_MS, 1.5 * replayMs));

    const snapshot = compacted.entries[0] as AuditCreatedEntry;
    expect(snapshot.compaction!.clocks.length).toBeLessThanOrEqual(MAX_AUDIT_PATH_CLOCKS);
    // The offline edit still lands, and the record is what the full history gives.
    const withOfflineEdit = merge(auditOf(compacted.entries), auditOf([offlineEdit])) as AuditOf<TestRecord>;
    expect(replayHistory(withOfflineEdit.entries, undefined)).toEqual(referenceRecord([offlineEdit, huge, ...ordinary], base));
  }, 120_000);

  it('is merged in linear time when it arrives late, into an already compacted audit', () => {
    const base = created({ id: RECORD_ID, a: { x: 0, y: 0 }, b: 0, c: { d: 0 }, list: [] });
    const huge = update(2, ...Array.from({ length: OPS }, (_, index) => replace(`j${index}.q`, 1)), ...Array.from({ length: OPS }, (_, index) => addItem(index)));
    const { audit } = serverAfter(ordinary, SMALL_LIMITS, base);

    const { result: merged, elapsedMs } = timed(() => merge(audit, auditOf([huge])) as AuditOf<TestRecord>);

    expect(replayHistory(merged.entries, undefined)).toEqual(referenceRecord([huge, ...ordinary], base));
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  }, 120_000);
});

// ─── Crafted paths (sc-4409 QA round 1) ──────────────────────────────────────

describe('a path that names a prototype key', () => {
  const pollutedKeys = (): string[] => ['qaPolluted', 'constructorPolluted', 'prototypePolluted'].filter(key => key in {});

  it.each([
    ['__proto__.qaPolluted'],
    ['constructor.prototype.constructorPolluted'],
    ['a.__proto__.qaPolluted'],
  ])('is ignored by replay (%s)', path => {
    const record = replayHistory([created(), update(1, replace(path, 'yes'))], undefined);
    expect([pollutedKeys(), record]).toEqual([[], replayHistory([created()], undefined)]);
  });

  it.each([
    ['__proto__.qaPolluted'],
    ['constructor.prototype.constructorPolluted'],
  ])('is ignored when merged into a compacted audit as a late entry (%s)', path => {
    const audit = auditOf(compactAuditEntries([created(), ...Array.from({ length: 9 }, (_, index) => update(index * 10 + 10, replace('b', index + 1)))], SMALL_LIMITS)!.entries);
    const merged = merge(audit, auditOf([update(5, replace(path, 'yes'))])) as AuditOf<TestRecord>;
    expect([pollutedKeys(), replayHistory(merged.entries, undefined)]).toEqual([[], replayHistory(audit.entries, undefined)]);
  });
});
