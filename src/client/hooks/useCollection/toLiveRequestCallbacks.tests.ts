import { describe, it, expect } from 'vitest';
import { toLiveRequestCallbacks } from './toLiveRequestCallbacks';

const onResponse = () => undefined;
const onSameResponse = () => undefined;
const onError = () => undefined;

describe('toLiveRequestCallbacks', () => {
  it('wraps a bare onResponse function', () => {
    expect(toLiveRequestCallbacks(onResponse)).toEqual({ onResponse, onSameResponse: undefined });
  });

  it('wraps the deprecated positional (onResponse, onSameResponse) pair', () => {
    expect(toLiveRequestCallbacks(onResponse, onSameResponse)).toEqual({ onResponse, onSameResponse });
  });

  it('passes a callbacks object through unchanged', () => {
    const callbacks = { onResponse, onSameResponse, onError };
    expect(toLiveRequestCallbacks(callbacks)).toBe(callbacks);
  });

  it.each([
    ['nothing', undefined],
    ['an object without onResponse', {} as never],
    ['an object whose onResponse is not a function', { onResponse: 'nope' } as never],
  ])('treats %s as a one-off (non-live) request', (_label, input) => {
    expect(toLiveRequestCallbacks(input)).toBeUndefined();
  });
});
