import { describe, expect, it } from 'vitest';
import type { AuditCompaction } from './auditor-models';
import { capPathClocks, isPathWithin, latestCoveringWrite, newerPathsWithin, recordPathWrite } from './pathClocks';

const compactionWith = (clocks: AuditCompaction['clocks']): AuditCompaction => ({ historyStart: '0', clocks });

describe('pathClocks', () => {
  it.each([
    ['a', 'a', true],
    ['a.b', 'a', true],
    ['items.[id:x].name', 'items', true],
    ['items.[id:x].name', 'items.[id:x]', true],
    ['ab', 'a', false],
    ['a', 'a.b', false],
    ['b.a', 'a', false],
  ])('isPathWithin(%s, %s) is %s', (path, ancestor, expected) => {
    expect(isPathWithin(path, ancestor)).toBe(expected);
  });

  it('moves a path\'s clock on and drops the older clocks inside it', () => {
    const clocks = recordPathWrite([{ path: 'a.x', id: '1' }, { path: 'a.y', id: '3' }, { path: 'b', id: '2' }], { path: 'a', id: '2' });
    expect(clocks).toEqual([{ path: 'a.y', id: '3' }, { path: 'b', id: '2' }, { path: 'a', id: '2' }]);
  });

  it('never moves a clock back', () => {
    const clocks = [{ path: 'a', id: '5' }];
    expect(recordPathWrite(clocks, { path: 'a', id: '4' })).toBe(clocks);
  });

  it.each([
    ['the path itself', 'a', '4'],
    ['a path containing it', 'a.x', '4'],
    ['the newest of several', 'a.x.y', '6'],
  ])('the latest covering write is that of %s', (_label, path, expected) => {
    expect(latestCoveringWrite(compactionWith([{ path: 'a', id: '4' }, { path: 'a.x.y', id: '6' }, { path: 'a.z', id: '9' }]), path)).toBe(expected);
  });

  it('is empty when nothing covers a path', () => {
    expect(latestCoveringWrite(compactionWith([{ path: 'a', id: '4' }]), 'b')).toBe('');
  });

  it('lists only the newer paths inside a path', () => {
    const compaction = compactionWith([{ path: 'a', id: '1' }, { path: 'a.x', id: '5' }, { path: 'a.y', id: '2' }, { path: 'b.x', id: '9' }]);
    expect(newerPathsWithin(compaction, { path: 'a', id: '3' })).toEqual(['a.x']);
  });

  it('folds the oldest clocks past the cap into their parent path, at the newest id folded into it', () => {
    const record = { list: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }], note: 'n' };
    const capped = capPathClocks(compactionWith([
      { path: 'list.[id:m1]', id: '1' }, { path: 'list.[id:m2]', id: '2' }, { path: 'list.[id:m3]', id: '5' }, { path: 'note', id: '4' },
    ]), record, 3);
    expect(capped.clocks).toEqual(expect.arrayContaining([{ path: 'list', id: '2' }, { path: 'list.[id:m3]', id: '5' }, { path: 'note', id: '4' }]));
    expect(capped.clocks).toHaveLength(3);
  });

  it('never covers a path outside the part of the record that churned', () => {
    const record = { list: Array.from({ length: 20 }, (_, index) => ({ id: `m${index}` })), note: 'n' };
    const clocks = Array.from({ length: 20 }, (_, index) => ({ path: `list.[id:m${index}]`, id: String(index + 10) }));
    const capped = capPathClocks(compactionWith(clocks), record, 5);
    expect([latestCoveringWrite(capped, 'note'), latestCoveringWrite(capped, 'other.x'), capped.clocks.length <= 5]).toEqual(['', '', true]);
  });

  it('drops a top-level clock for a key the record does not hold (junk paths, removed fields)', () => {
    const clocks = Array.from({ length: 30 }, (_, index) => ({ path: `junk${index}.x`, id: String(index + 10) }));
    const capped = capPathClocks(compactionWith([...clocks, { path: 'note', id: '50' }]), { note: 'n' }, 5);
    expect(capped.clocks.length).toBeLessThanOrEqual(5);
    expect([latestCoveringWrite(capped, 'note'), latestCoveringWrite(capped, 'a.x')]).toEqual(['50', '']);
  });

  it('keeps a clock per top-level key the record holds, even past the cap', () => {
    const record = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`k${index}`, index]));
    const clocks = Array.from({ length: 8 }, (_, index) => ({ path: `k${index}`, id: String(index + 10) }));
    expect(capPathClocks(compactionWith(clocks), record, 3).clocks).toHaveLength(8);
  });

  it('folds the oldest clocks until their paths fit the character limit', () => {
    const longPath = `a.${'p'.repeat(40)}`;
    const capped = capPathClocks(compactionWith([{ path: `${longPath}1`, id: '1' }, { path: `${longPath}2`, id: '2' }, { path: 'c', id: '3' }]), { a: {}, c: 1 }, 10, 50);
    expect(capped.clocks).toEqual(expect.arrayContaining([{ path: 'a', id: '1' }, { path: `${longPath}2`, id: '2' }, { path: 'c', id: '3' }]));
    expect(capped.clocks.reduce((total, { path }) => total + path.length, 0)).toBeLessThanOrEqual(50);
  });
});
