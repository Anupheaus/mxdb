import { describe, it, expect, vi } from 'vitest';
import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import {
  AuditEntryType,
  OperationType,
  TargetPosition,
  type AuditEntry,
  type AuditOperation,
} from './auditor-models';
import { contentHash } from './hash';
import {
  applyOp,
  filterValidEntries,
  parsePath,
  replayHistory,
  replayHistoryEndState,
  resolveArrayIndex,
} from './replay';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

interface Item {
  id?: string;
  _id?: string;
  label?: string;
}

interface TestRecord extends MXDBRecord {
  name?: string;
  tags?: string[];
  items?: Item[];
  nested?: { inner?: { value?: number } };
}

/** Fixed-width, lexicographically ordered pseudo-ULIDs. */
function id(sequence: number): string {
  return `01J${String(sequence).padStart(23, '0')}`;
}

function makeRecord(overrides: Partial<TestRecord> = {}): TestRecord {
  return { id: 'r1', name: 'original', ...overrides };
}

const created = (seq: number, record: TestRecord = makeRecord()): AuditEntry<TestRecord> =>
  ({ type: AuditEntryType.Created, id: id(seq), record });
const setName = (seq: number, name: string): AuditEntry<TestRecord> =>
  ({ type: AuditEntryType.Updated, id: id(seq), ops: [{ type: OperationType.Replace, path: 'name', value: name }] });
const deleted = (seq: number): AuditEntry<TestRecord> => ({ type: AuditEntryType.Deleted, id: id(seq) });
const restored = (seq: number, record?: TestRecord): AuditEntry<TestRecord> =>
  (record == null ? { type: AuditEntryType.Restored, id: id(seq) } : { type: AuditEntryType.Restored, id: id(seq), record });
const branched = (seq: number): AuditEntry<TestRecord> => ({ type: AuditEntryType.Branched, id: id(seq) });

interface FakeLogger {
  logger: Logger;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

function makeLogger(): FakeLogger {
  const warn = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();
  const logger = { warn, error, debug, info: vi.fn(), silly: vi.fn() } as unknown as Logger;
  return { logger, warn, error, debug };
}

/** Applies `op` to a fresh clone of `record` and returns the mutated clone. */
function applied(record: TestRecord, op: AuditOperation, logger?: Logger): TestRecord {
  const clone = structuredClone(record);
  applyOp(clone, op, logger);
  return clone;
}

// ─── parsePath ────────────────────────────────────────────────────────────────

describe('parsePath', () => {
  const cases: [string, (string | number)[]][] = [
    ['', []],
    ['name', ['name']],
    ['nested.inner.value', ['nested', 'inner', 'value']],
    ['tags.2', ['tags', 2]],
    ['items.[id:abc].label', ['items', '[id:abc]', 'label']],
    ['items.[_id:42]', ['items', '[_id:42]']],
    ['a.1.5', ['a', 1, 5]],
    ['a.1.5x', ['a', 1, '5x']],
    ['a..b', ['a', '', 'b']],
  ];

  it.each(cases)('splits %j into %j', (path, expected) => {
    expect(parsePath(path)).toEqual(expected);
  });
});

// ─── resolveArrayIndex ────────────────────────────────────────────────────────

describe('resolveArrayIndex', () => {
  const items: Item[] = [{ id: 'a', label: 'A' }, { _id: 'b', label: 'B' }, { id: '3', label: 'C' }];

  const cases: [string, unknown[], string | number, string | undefined, number | undefined][] = [
    ['an in-range plain index', items, 1, undefined, 1],
    ['an out-of-range plain index', items, 3, undefined, undefined],
    ['a hash matching an element', items, 0, contentHash(items[2]), 2],
    ['a hash matching no element', items, 0, 'deadbeefdeadbeef', undefined],
    ['a boxed id', items, '[id:a]', undefined, 0],
    ['a boxed _id', items, '[_id:b]', undefined, 1],
    ['a boxed id compared as a string', items, '[id:3]', undefined, 2],
    ['a boxed id that is not present', items, '[id:zzz]', undefined, undefined],
    ['a boxed id against primitive elements', ['a', null], '[id:a]', undefined, undefined],
    ['a non-boxed string segment', items, 'label', undefined, undefined],
  ];

  it.each(cases)('resolves %s', (_label, array, segment, hash, expected) => {
    expect(resolveArrayIndex(array, segment, hash)).toBe(expected);
  });
});

// ─── filterValidEntries ───────────────────────────────────────────────────────

describe('filterValidEntries', () => {
  const invalidEntries: [string, unknown][] = [
    ['null', null],
    ['a string', 'entry'],
    ['a numeric id', { id: 1, type: AuditEntryType.Deleted }],
    ['a missing type', { id: id(1) }],
    ['a string type', { id: id(1), type: 'Deleted' }],
  ];

  it.each(invalidEntries)('drops %s', (_label, entry) => {
    expect(filterValidEntries([deleted(2), entry])).toEqual([deleted(2)]);
  });

  it('warns with the number of dropped entries', () => {
    const { logger, warn } = makeLogger();

    filterValidEntries([deleted(2), null, 'x'], logger);

    expect(warn).toHaveBeenCalledWith(expect.any(String), { removed: 2, total: 3 });
  });

  it('does not warn when every entry is valid', () => {
    const { logger, warn } = makeLogger();

    filterValidEntries([deleted(2)], logger);

    expect(warn).not.toHaveBeenCalled();
  });
});

// ─── applyOp: object targets ──────────────────────────────────────────────────

describe('applyOp on object fields', () => {
  it('replaces a top-level field', () => {
    expect(applied(makeRecord(), { type: OperationType.Replace, path: 'name', value: 'next' }).name).toBe('next');
  });

  it('adds a nested field', () => {
    const record = makeRecord({ nested: { inner: {} } });

    expect(applied(record, { type: OperationType.Add, path: 'nested.inner.value', value: 5 }).nested).toEqual({ inner: { value: 5 } });
  });

  it('removes a field', () => {
    expect(applied(makeRecord(), { type: OperationType.Remove, path: 'name' })).toEqual({ id: 'r1' });
  });

  it('ignores a move op targeting an object key', () => {
    expect(applied(makeRecord(), { type: OperationType.Move, path: 'name' })).toEqual(makeRecord());
  });

  it('returns the same record reference it was given', () => {
    const record = makeRecord();

    expect(applyOp(record, { type: OperationType.Replace, path: 'name', value: 'x' })).toBe(record);
  });

  const unreachablePaths: [string, TestRecord, string][] = [
    ['an empty path', makeRecord(), ''],
    ['a missing intermediate object', makeRecord(), 'nested.inner.value'],
    ['a primitive intermediate value', makeRecord(), 'name.length.x'],
    ['a missing final parent', makeRecord({ nested: {} }), 'nested.inner.value'],
    ['an unresolvable intermediate array element', makeRecord({ items: [{ id: 'a' }] }), 'items.[id:zzz].label'],
  ];

  it.each(unreachablePaths)('leaves the record unchanged for %s', (_label, record, path) => {
    expect(applied(record, { type: OperationType.Replace, path, value: 'x' })).toEqual(record);
  });

  it('warns when an op cannot reach its target', () => {
    const { logger, warn } = makeLogger();

    applied(makeRecord(), { type: OperationType.Replace, path: 'nested.inner.value', value: 1 }, logger);

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ─── applyOp: array targets ───────────────────────────────────────────────────

describe('applyOp on array elements', () => {
  const tagsRecord = (): TestRecord => makeRecord({ tags: ['a', 'b', 'c'] });

  const cases: [string, AuditOperation, string[]][] = [
    ['removes by index', { type: OperationType.Remove, path: 'tags.1' }, ['a', 'c']],
    ['removes by content hash', { type: OperationType.Remove, path: 'tags.0', hash: contentHash('c') }, ['a', 'b']],
    ['ignores a remove whose target is missing', { type: OperationType.Remove, path: 'tags.9' }, ['a', 'b', 'c']],
    ['replaces by index', { type: OperationType.Replace, path: 'tags.0', value: 'z' }, ['z', 'b', 'c']],
    ['ignores a replace whose hash matches nothing', { type: OperationType.Replace, path: 'tags.0', value: 'z', hash: 'nope' }, ['a', 'b', 'c']],
    ['adds to the front', { type: OperationType.Add, path: 'tags.1', value: 'z', position: TargetPosition.First }, ['z', 'a', 'b', 'c']],
    ['adds to the end', { type: OperationType.Add, path: 'tags.1', value: 'z', position: TargetPosition.Last }, ['a', 'b', 'c', 'z']],
    ['adds to the end when no position is given', { type: OperationType.Add, path: 'tags.0', value: 'z' }, ['a', 'b', 'c', 'z']],
    [
      'inserts at the resolved index for any other position',
      { type: OperationType.Add, path: 'tags.1', value: 'z', position: 'MIDDLE' as TargetPosition },
      ['a', 'z', 'b', 'c'],
    ],
    [
      'appends for any other position when the index is unresolved',
      { type: OperationType.Add, path: 'tags.9', value: 'z', position: 'MIDDLE' as TargetPosition },
      ['a', 'b', 'c', 'z'],
    ],
    ['moves an element to the front', { type: OperationType.Move, path: 'tags.2', position: TargetPosition.First }, ['c', 'a', 'b']],
    ['moves an element to the end', { type: OperationType.Move, path: 'tags.0', position: TargetPosition.Last }, ['b', 'c', 'a']],
    ['ignores a move whose target is missing', { type: OperationType.Move, path: 'tags.9', position: TargetPosition.First }, ['a', 'b', 'c']],
  ];

  it.each(cases)('%s', (_label, op, expected) => {
    expect(applied(tagsRecord(), op).tags).toEqual(expected);
  });

  it('updates a field of an element addressed by boxed id', () => {
    const record = makeRecord({ items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });

    const result = applied(record, { type: OperationType.Replace, path: 'items.[id:b].label', value: 'B2' });

    expect(result.items).toEqual([{ id: 'a', label: 'A' }, { id: 'b', label: 'B2' }]);
  });

  it('updates a field of an element addressed by hash even after it has moved', () => {
    const moved: Item = { label: 'target' };
    const record = makeRecord({ items: [{ label: 'other' }, moved] });

    const result = applied(record, { type: OperationType.Replace, path: 'items.0.label', value: 'hit', hash: contentHash(moved) });

    expect(result.items).toEqual([{ label: 'other' }, { label: 'hit' }]);
  });
});

// ─── replayHistoryEndState ────────────────────────────────────────────────────

describe('replayHistoryEndState', () => {
  it('applies entries in ULID order regardless of insertion order', () => {
    const entries = [created(1), setName(5, 'latest'), setName(3, 'older')];

    expect(replayHistory(entries, undefined)?.name).toBe('latest');
  });

  it('keeps the record deleted when an update has a higher ULID than the delete', () => {
    const { live } = replayHistoryEndState([created(1), deleted(2), setName(3, 'after-delete')], undefined);

    expect(live).toBeUndefined();
  });

  it('advances the shadow with updates made after a delete', () => {
    const { shadow } = replayHistoryEndState([created(1), deleted(2), setName(3, 'after-delete')], undefined);

    expect(shadow?.name).toBe('after-delete');
  });

  it('keeps the shadow advancing across repeated deletes', () => {
    const { shadow } = replayHistoryEndState([created(1), deleted(2), setName(3, 'x'), deleted(4), setName(5, 'y')], undefined);

    expect(shadow?.name).toBe('y');
  });

  it('restores the shadow to live when a payload-free Restored entry follows a delete', () => {
    const { live } = replayHistoryEndState([created(1), deleted(2), setName(3, 'after-delete'), restored(4)], undefined);

    expect(live).toEqual(makeRecord({ name: 'after-delete' }));
  });

  it('restores the supplied snapshot when the Restored entry carries a record', () => {
    const snapshot = makeRecord({ name: 'snapshot' });

    const { live } = replayHistoryEndState([created(1), deleted(2), restored(3, snapshot)], undefined);

    expect(live).toEqual(snapshot);
  });

  it('leaves the record absent when a payload-free Restored entry has nothing to restore', () => {
    const { live } = replayHistoryEndState([restored(1)], undefined);

    expect(live).toBeUndefined();
  });

  it('ignores Branched anchors when materialising state', () => {
    const { live } = replayHistoryEndState([branched(1), setName(2, 'from-base')], makeRecord());

    expect(live).toEqual(makeRecord({ name: 'from-base' }));
  });

  it('skips updates that have no Created entry or base record to apply to', () => {
    const { shadow } = replayHistoryEndState([branched(1), setName(2, 'orphan')], undefined);

    expect(shadow).toBeUndefined();
  });

  it('logs an error when an update is skipped for lack of an anchor', () => {
    const { logger, error } = makeLogger();

    replayHistoryEndState([setName(2, 'orphan')], undefined, logger);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('no anchor'), expect.objectContaining({ entryId: id(2), ops: 1 }));
  });

  it('logs an error and keeps the base record when a Created entry has no payload', () => {
    const { logger, error } = makeLogger();
    const entries = [{ type: AuditEntryType.Created, id: id(1) } as AuditEntry<TestRecord>];

    const { live } = replayHistoryEndState(entries, makeRecord({ name: 'base' }), logger);

    expect({ live, errorCalls: error.mock.calls.length }).toEqual({ live: makeRecord({ name: 'base' }), errorCalls: 1 });
  });

  it('resets state to the payload of a later Created entry', () => {
    const { live } = replayHistoryEndState([created(1), setName(2, 'x'), created(3, makeRecord({ name: 'reset' }))], undefined);

    expect(live?.name).toBe('reset');
  });

  it('treats an Updated entry with no ops as a no-op', () => {
    const entries = [created(1), { type: AuditEntryType.Updated, id: id(2) } as AuditEntry<TestRecord>];

    expect(replayHistory(entries, undefined)).toEqual(makeRecord());
  });

  it('does not mutate the Created entry payload while applying updates', () => {
    const record = makeRecord();
    const entries = [created(1, record), setName(2, 'changed')];

    replayHistory(entries, undefined);

    expect(record.name).toBe('original');
  });

  it('ignores structurally invalid entries', () => {
    const entries = [created(1), null, setName(3, 'valid')] as unknown as AuditEntry<TestRecord>[];

    expect(replayHistory(entries, undefined)?.name).toBe('valid');
  });

  it('returns the base record when there are no entries', () => {
    expect(replayHistory([], makeRecord({ name: 'base' }))).toEqual(makeRecord({ name: 'base' }));
  });

  it('returns nothing when there are no entries and no base record', () => {
    expect(replayHistoryEndState([], undefined)).toEqual({ live: undefined, shadow: undefined });
  });
});

describe('applyOp on immutable targets', () => {
  it('swallows the write failure and warns instead of throwing', () => {
    const { logger, warn } = makeLogger();
    const record = Object.freeze(makeRecord());

    applyOp(record, { type: OperationType.Replace, path: 'name', value: 'x' }, logger);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('applyOp threw'), expect.objectContaining({ path: 'name' }));
  });
});
