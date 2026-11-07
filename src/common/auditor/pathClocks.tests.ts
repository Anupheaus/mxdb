import { describe, expect, it } from 'vitest';
import type { AuditCompaction } from './auditor-models';
import { capPathClocks, isPathWithin, latestCoveringWrite, newerPathsWithin, recordPathWrite } from './pathClocks';

const compactionWith = (clocks: AuditCompaction['clocks'], clocksFloor?: string): AuditCompaction => ({ historyStart: '0', clocks, clocksFloor });

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
    ['the floor, when no clock covers it', 'b', '2'],
  ])('the latest covering write is that of %s', (_label, path, expected) => {
    expect(latestCoveringWrite(compactionWith([{ path: 'a', id: '4' }, { path: 'a.x.y', id: '6' }, { path: 'a.z', id: '9' }], '2'), path)).toBe(expected);
  });

  it('is empty when nothing covers a path and there is no floor', () => {
    expect(latestCoveringWrite(compactionWith([{ path: 'a', id: '4' }]), 'b')).toBe('');
  });

  it('lists only the newer paths inside a path', () => {
    const compaction = compactionWith([{ path: 'a', id: '1' }, { path: 'a.x', id: '5' }, { path: 'a.y', id: '2' }, { path: 'b.x', id: '9' }]);
    expect(newerPathsWithin(compaction, { path: 'a', id: '3' })).toEqual(['a.x']);
  });

  it('drops the oldest clocks past the cap and raises the floor to the newest dropped', () => {
    const capped = capPathClocks(compactionWith([{ path: 'a', id: '3' }, { path: 'b', id: '1' }, { path: 'c', id: '2' }, { path: 'd', id: '4' }]), 2);
    expect(capped).toEqual(compactionWith([{ path: 'a', id: '3' }, { path: 'd', id: '4' }], '2'));
  });

  it('drops the oldest clocks until their paths fit the character limit', () => {
    const longPath = 'p'.repeat(40);
    const capped = capPathClocks(compactionWith([{ path: `${longPath}1`, id: '1' }, { path: `${longPath}2`, id: '2' }, { path: 'c', id: '3' }]), 10, 50);
    expect(capped).toEqual(compactionWith([{ path: `${longPath}2`, id: '2' }, { path: 'c', id: '3' }], '1'));
  });

  it('keeps a higher floor when the dropped clocks are older than it', () => {
    expect(capPathClocks(compactionWith([{ path: 'a', id: '3' }, { path: 'b', id: '1' }], '2'), 1).clocksFloor).toBe('2');
  });
});
