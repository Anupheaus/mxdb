// @vitest-environment jsdom
import '@anupheaus/common';
import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useDeepEqualValue } from './useDeepEqualValue';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Renders the hook with each value in turn, returning what it gave back each time. */
function renderWith<T>(values: T[]): T[] {
  const seen: T[] = [];
  function Probe({ value }: { value: T }): null {
    seen.push(useDeepEqualValue(value));
    return null;
  }
  const root = createRoot(document.createElement('div'));
  for (const value of values) act(() => { root.render(<Probe value={value} />); });
  act(() => root.unmount());
  return seen;
}

describe('useDeepEqualValue', () => {
  it('keeps the first reference while each new value is deep-equal to it — DateTimes by instant', () => {
    const at = DateTime.fromISO('2026-09-29T10:00:00Z', { zone: 'utc' });
    const first = { filters: { leadId: 'l1', from: at } };
    const [a, b, c] = renderWith([first, { filters: { leadId: 'l1', from: at.setZone('Europe/London') } }, { filters: { leadId: 'l1', from: at } }]);
    expect(a).toBe(first);
    expect(b).toBe(first);
    expect(c).toBe(first);
  });

  it('gives the new value once it differs', () => {
    const first = { filters: { leadId: 'l1' } };
    const second = { filters: { leadId: 'l2' } };
    const [a, b] = renderWith([first, second]);
    expect(a).toBe(first);
    expect(b).toBe(second);
  });

  it('never hashes what it compares', () => {
    const hash = vi.spyOn(Object, 'hash');
    renderWith([{ a: 1 }, { a: 1 }, { a: 2 }]);
    expect(hash).not.toHaveBeenCalled();
    hash.mockRestore();
  });
});
