import { describe, it, expect } from 'vitest';
import { deterministicJson, contentHash, hashRecord } from './hash';
import type { Record as MXDBRecord } from '@anupheaus/common';

// ─── deterministicJson ────────────────────────────────────────────────────────

describe('deterministicJson', () => {
  it('serialises null', () => {
    expect(deterministicJson(null)).toBe('null');
  });

  it('serialises undefined', () => {
    expect(deterministicJson(undefined)).toBe('undefined');
  });

  it('serialises a number', () => {
    expect(deterministicJson(42)).toBe('42');
    expect(deterministicJson(-3.14)).toBe('-3.14');
    expect(deterministicJson(0)).toBe('0');
  });

  it('serialises a string', () => {
    expect(deterministicJson('hello')).toBe('"hello"');
    expect(deterministicJson('')).toBe('""');
  });

  it('serialises a boolean', () => {
    expect(deterministicJson(true)).toBe('true');
    expect(deterministicJson(false)).toBe('false');
  });

  it('serialises an array', () => {
    expect(deterministicJson([1, 2, 3])).toBe('[1,2,3]');
    expect(deterministicJson([])).toBe('[]');
  });

  it('treats undefined array elements as null', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(deterministicJson([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('sorts object keys alphabetically', () => {
    expect(deterministicJson({ z: 1, a: 2, m: 3 })).toBe('{"a":2,"m":3,"z":1}');
  });

  it('omits object keys with undefined values', () => {
    expect(deterministicJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('serialises nested objects deterministically', () => {
    const obj = { b: { y: 1, x: 2 }, a: [3, 1, 2] };
    expect(deterministicJson(obj)).toBe('{"a":[3,1,2],"b":{"x":2,"y":1}}');
  });

  it('produces the same output for equal objects with different key insertion order', () => {
    const a = { z: 'last', a: 'first', m: 'mid' };
    const b = { m: 'mid', z: 'last', a: 'first' };
    expect(deterministicJson(a)).toBe(deterministicJson(b));
  });
});

// ─── contentHash ──────────────────────────────────────────────────────────────

describe('contentHash', () => {
  it('returns a 16-character hex string', () => {
    const h = contentHash({ id: 'x', value: 1 });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns the same hash for equal objects with different key order', () => {
    const a = { z: 1, a: 2 };
    const b = { a: 2, z: 1 };
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('returns different hashes for different objects', () => {
    expect(contentHash({ x: 1 })).not.toBe(contentHash({ x: 2 }));
  });

  it('returns different hashes for null vs undefined', () => {
    expect(contentHash(null)).not.toBe(contentHash(undefined));
  });

  it('returns a stable hash (same value every call)', () => {
    const obj = { id: 'abc', name: 'test' };
    expect(contentHash(obj)).toBe(contentHash(obj));
  });
});

// ─── hashRecord ───────────────────────────────────────────────────────────────

describe('hashRecord', () => {
  function rec(fields: Partial<MXDBRecord> & Record<string, unknown>): MXDBRecord {
    return { id: 'r1', ...fields } as MXDBRecord;
  }

  it('returns a 16-character hex string', async () => {
    const h = await hashRecord(rec({ name: 'alice' }));
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns the same hash for the same record called twice', async () => {
    const r = rec({ name: 'alice', age: 30 });
    const h1 = await hashRecord(r);
    const h2 = await hashRecord(r);
    expect(h1).toBe(h2);
  });

  it('returns different hashes for records with different field values', async () => {
    const a = rec({ name: 'alice' });
    const b = rec({ name: 'bob' });
    expect(await hashRecord(a)).not.toBe(await hashRecord(b));
  });

  it('returns the same hash regardless of key insertion order', async () => {
    const a = rec({ z: 9, a: 1 });
    const b = rec({ a: 1, z: 9 });
    expect(await hashRecord(a)).toBe(await hashRecord(b));
  });
});
