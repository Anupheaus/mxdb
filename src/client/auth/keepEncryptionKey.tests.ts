import { describe, it, expect } from 'vitest';
import { keepEncryptionKey } from './keepEncryptionKey';

describe('keepEncryptionKey', () => {
  it('keeps the current key instance when the next one has the same bytes', () => {
    const current = new Uint8Array([1, 2, 3, 4]);
    const next = new Uint8Array([1, 2, 3, 4]);
    expect(keepEncryptionKey(current, next)).toBe(current);
  });

  it('takes the next key when the bytes differ', () => {
    const current = new Uint8Array([1, 2, 3, 4]);
    const next = new Uint8Array([1, 2, 3, 5]);
    expect(keepEncryptionKey(current, next)).toBe(next);
  });

  it('takes the next key when the lengths differ', () => {
    const next = new Uint8Array([1, 2, 3]);
    expect(keepEncryptionKey(new Uint8Array([1, 2, 3, 4]), next)).toBe(next);
  });

  it('takes the next key when there is no current key', () => {
    const next = new Uint8Array([1, 2, 3, 4]);
    expect(keepEncryptionKey(undefined, next)).toBe(next);
  });

  it('clears the key when the next one is undefined', () => {
    expect(keepEncryptionKey(new Uint8Array([1]), undefined)).toBeUndefined();
  });
});
