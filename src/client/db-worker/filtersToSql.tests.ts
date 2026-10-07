import { describe, it, expect } from 'vitest';
import type { DataFilters } from '@anupheaus/common';
import { filtersToSql } from './filtersToSql';

type WideRow = Record<string, unknown>;

/** `DataFilters<Record>` is too narrow for many operator/field combinations exercised here. */
function filters(f: Record<string, unknown>) {
  return f as DataFilters<WideRow>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function field(path: string) {
  return `json_extract(data, '$.${path}')`;
}

// ─── No filter ────────────────────────────────────────────────────────────────

describe('filtersToSql — empty / null', () => {
  it('returns empty where for undefined', () => {
    const { where, params } = filtersToSql(undefined);
    expect(where).toBe('');
    expect(params).toEqual([]);
  });

  it('returns empty where for empty object', () => {
    const { where } = filtersToSql({});
    expect(where).toBe('');
  });
});

// ─── Scalar operators ─────────────────────────────────────────────────────────

describe('filtersToSql — scalar operators', () => {
  it('$eq short-hand (direct value)', () => {
    const { where, params } = filtersToSql({ status: 'done' });
    expect(where).toBe(`${field('status')} = ?`);
    expect(params).toEqual(['done']);
  });

  it('$eq explicit', () => {
    const { where, params } = filtersToSql({ count: { $eq: 5 } });
    expect(where).toBe(`${field('count')} = ?`);
    expect(params).toEqual([5]);
  });

  it('$ne', () => {
    // As in MongoDB, a record missing the field is "not archived" too.
    const { where, params } = filtersToSql({ status: { $ne: 'archived' } });
    expect(where).toBe(`(${field('status')} IS NULL OR ${field('status')} != ?)`);
    expect(params).toEqual(['archived']);
  });

  it('$gt', () => {
    const { where, params } = filtersToSql({ age: { $gt: 18 } });
    expect(where).toBe(`${field('age')} > ?`);
    expect(params).toEqual([18]);
  });

  it('$lt', () => {
    const { where, params } = filtersToSql({ price: { $lt: 100 } });
    expect(where).toBe(`${field('price')} < ?`);
    expect(params).toEqual([100]);
  });

  it('$gte', () => {
    const { where, params } = filtersToSql({ score: { $gte: 90 } });
    expect(where).toBe(`${field('score')} >= ?`);
    expect(params).toEqual([90]);
  });

  it('$lte', () => {
    const { where, params } = filtersToSql({ score: { $lte: 50 } });
    expect(where).toBe(`${field('score')} <= ?`);
    expect(params).toEqual([50]);
  });
});

// ─── String operators ─────────────────────────────────────────────────────────

describe('filtersToSql — string operators', () => {
  it('$regex with string pattern', () => {
    const { where, params } = filtersToSql(filters({ name: { $regex: '^jo' } }));
    expect(where).toBe(`${field('name')} REGEXP ?`);
    expect(params).toEqual(['^jo']);
  });

  // sc-2518: outside MXDB's filter whitelist, so the whole query matches nothing on every engine.
  it.each([
    ['$like', { name: { $like: '%alice%' } }], ['$beginsWith', { name: { $beginsWith: 'Jo' } }],
    ['$endsWith', { email: { $endsWith: '@example.com' } }], ['$regex with a RegExp (flags, and it does not survive JSON)', { name: { $regex: /^jo/i } }],
    ['$regex with $options', { name: { $regex: 'jo', $options: 'i' } }], ['$regex that does not compile', { name: { $regex: '(' } }],
    ['$ni', { role: { $ni: ['admin'] } }], ['$size', { items: { $size: 3 } }], ['a nested-object value (sc-2783)', { address: { city: 'London' } }],
  ])('%s matches nothing', (_label, condition) => {
    expect(filtersToSql(filters(condition))).toEqual({ where: '0', params: [] });
  });
});

// ─── Set operators ────────────────────────────────────────────────────────────

describe('filtersToSql — set operators', () => {
  it('$in with multiple values', () => {
    const { where, params } = filtersToSql({ status: { $in: ['a', 'b', 'c'] } });
    expect(where).toBe(`${field('status')} IN (?, ?, ?)`);
    expect(params).toEqual(['a', 'b', 'c']);
  });

  it('$in shorthand (direct array)', () => {
    const { where, params } = filtersToSql({ status: ['a', 'b'] });
    expect(where).toBe(`${field('status')} IN (?, ?)`);
    expect(params).toEqual(['a', 'b']);
  });

  it('$in with empty array produces falsy 0 condition', () => {
    const { where, params } = filtersToSql(filters({ status: { $in: [] } }));
    expect(where).toBe('0');
    expect(params).toEqual([]);
  });

  it('$nin', () => {
    const { where, params } = filtersToSql({ role: { $nin: ['admin', 'superuser'] } });
    expect(where).toBe(`(${field('role')} IS NULL OR ${field('role')} NOT IN (?, ?))`);
    expect(params).toEqual(['admin', 'superuser']);
  });

  it('$nin with empty array produces truthy 1 condition', () => {
    const { where, params } = filtersToSql(filters({ role: { $nin: [] } }));
    expect(where).toBe('1');
    expect(params).toEqual([]);
  });
});

// ─── Existence ────────────────────────────────────────────────────────────────

describe('filtersToSql — $exists', () => {
  it('$exists: true → IS NOT NULL', () => {
    const { where, params } = filtersToSql({ email: { $exists: true } });
    expect(where).toBe(`${field('email')} IS NOT NULL`);
    expect(params).toEqual([]);
  });

  it('$exists: false → IS NULL', () => {
    const { where, params } = filtersToSql({ deletedAt: { $exists: false } });
    expect(where).toBe(`${field('deletedAt')} IS NULL`);
    expect(params).toEqual([]);
  });
});

// ─── Array operators ──────────────────────────────────────────────────────────

describe('filtersToSql — array operators', () => {
  it('$all checks all values appear in JSON array field', () => {
    const { where, params } = filtersToSql({ tags: { $all: ['react', 'ts'] } });
    expect(where).toContain('json_each(');
    expect(where).toContain('COUNT(*)');
    expect(params).toContain('react');
    expect(params).toContain('ts');
    // Final param should be the expected count (2)
    expect(params[params.length - 1]).toBe(2);
  });
});

// ─── Null / nested field ──────────────────────────────────────────────────────

describe('filtersToSql — null and nested fields', () => {
  it('null value → IS NULL', () => {
    const { where } = filtersToSql({ deletedAt: null });
    expect(where).toBe(`${field('deletedAt')} IS NULL`);
  });

  it('dotted field path', () => {
    const { where, params } = filtersToSql(filters({ 'address.city': 'London' }));
    expect(where).toBe(`${field('address.city')} = ?`);
    expect(params).toEqual(['London']);
  });

  it('a field name that is not a field path matches nothing — it is never written into the SQL', () => {
    expect(filtersToSql(filters({ 'x\') OR 1=1 OR (\'': 1 }))).toEqual({ where: '0', params: [] });
  });
});

// ─── Logical operators ────────────────────────────────────────────────────────

describe('filtersToSql — $or / $and', () => {
  it('$or wraps in OR', () => {
    const { where, params } = filtersToSql({ $or: [{ status: 'a' }, { status: 'b' }] });
    expect(where).toContain('OR');
    expect(where).toContain(field('status'));
    expect(params).toEqual(['a', 'b']);
  });

  it('$and wraps in AND', () => {
    const { where, params } = filtersToSql({ $and: [{ active: true }, { role: 'admin' }] });
    expect(where).toContain('AND');
    expect(params).toContain(true);
    expect(params).toContain('admin');
  });

  it('multiple top-level keys are combined with AND', () => {
    const { where, params } = filtersToSql({ status: 'active', role: 'admin' });
    expect(where).toContain('AND');
    expect(params).toContain('active');
    expect(params).toContain('admin');
  });
});

// ─── Parameterisation safety ──────────────────────────────────────────────────

describe('filtersToSql — no SQL injection', () => {
  it('values are never interpolated into the SQL string', () => {
    const malicious = "'; DROP TABLE todos_live; --";
    const { where, params } = filtersToSql({ name: malicious });
    expect(where).not.toContain(malicious);
    expect(params).toContain(malicious);
  });
});

// ─── Additional edge cases ─────────────────────────────────────────────────────

describe('filtersToSql — edge cases', () => {
  // sc-2518: a condition with no value is "the field is missing", never dropped — dropping it read every record.
  it('reads an undefined value at top level as "missing", not as no condition', () => {
    const { where, params } = filtersToSql({ name: 'alice', extra: undefined });
    expect(where).toBe(`(${field('name')} = ? AND ${field('extra')} IS NULL)`);
    expect(params).toEqual(['alice']);
  });

  it('a filter whose only condition has no value matches records missing that field, never every record', () => {
    expect(filtersToSql({ leadId: undefined }).where).toBe(`${field('leadId')} IS NULL`);
  });

  it('reads an undefined nested field as "missing"', () => {
    expect(filtersToSql(filters({ 'address.id': undefined })).where).toBe(`${field('address.id')} IS NULL`);
  });

  it('reads an undefined value inside $or / $and branches as "missing"', () => {
    const { where, params } = filtersToSql({ $or: [{ leadId: undefined }, { status: 'a' }], $and: [{ addressId: undefined }] });
    expect(where).toBe(`((${field('leadId')} IS NULL OR ${field('status')} = ?) AND ${field('addressId')} IS NULL)`);
    expect(params).toEqual(['a']);
  });

  it('an operator with no operand (or null, or the wrong type) matches nothing — it is never dropped', () => {
    for (const condition of [{ $eq: undefined }, { $eq: null }, { $ne: undefined }, { $ne: null }, { $in: undefined }, { $nin: 'x' }, { $gte: undefined }]) {
      expect(filtersToSql(filters({ leadId: condition })).where).toBe('0');
    }
  });

  it('a missing value in an $in list (or bare array) also matches records missing the field', () => {
    const inList = filtersToSql({ leadId: { $in: ['l1', undefined] } });
    expect(inList.where).toBe(`(${field('leadId')} IN (?) OR ${field('leadId')} IS NULL)`);
    expect(inList.params).toEqual(['l1']);
    expect(filtersToSql(filters({ leadId: [undefined] })).where).toBe(`${field('leadId')} IS NULL`);
  });

  it('a missing value in a $nin list excludes records missing the field', () => {
    const notIn = filtersToSql({ leadId: { $nin: ['l1', undefined] } });
    expect(notIn.where).toBe(`(${field('leadId')} IS NOT NULL AND ${field('leadId')} NOT IN (?))`);
    expect(notIn.params).toEqual(['l1']);
    expect(filtersToSql({ leadId: { $nin: [null] } }).where).toBe(`${field('leadId')} IS NOT NULL`);
  });

  it('still reads no filter, and an empty filter, as every record', () => {
    expect(filtersToSql(undefined).where).toBe('');
    expect(filtersToSql({}).where).toBe('');
  });

  it('an unset bound beside a sound one fails the whole condition closed', () => {
    const { where, params } = filtersToSql({ score: { $gt: 5, $lt: undefined } });
    expect(where).toBe('0');
    expect(params).toEqual([]);
  });

  it('$all with an empty array matches nothing, as in MongoDB', () => {
    const { where, params } = filtersToSql(filters({ tags: { $all: [] } }));
    expect(where).toBe('0');
    expect(params).toEqual([]);
  });

  it('$elemMatch, not translated to SQL yet (sc-2758), matches nothing rather than everything', () => {
    const { where } = filtersToSql({ items: { $elemMatch: { value: 10 } } });
    expect(where).toBe('0');
  });

  it('an unknown operator makes the whole query match nothing', () => {
    const { where } = filtersToSql({ status: 'a', field: { $unknownOp: 'value' } } as any);
    expect(where).toBe('0');
  });

  it('$not negates operators, counting a missing field as "not"', () => {
    const { where, params } = filtersToSql(filters({ value: { $not: { $gt: 5 } } }));
    expect(where).toBe(`NOT COALESCE(${field('value')} > ?, 0)`);
    expect(params).toEqual([5]);
  });

  it('$nor matches records no branch matches, a missing field counting as no match', () => {
    const { where, params } = filtersToSql(filters({ $nor: [{ status: 'a' }, { status: 'b' }] }));
    expect(where).toBe(`NOT COALESCE((${field('status')} = ? OR ${field('status')} = ?), 0)`);
    expect(params).toEqual(['a', 'b']);
  });

  it('$or with a single branch does not double-wrap in parentheses', () => {
    const { where } = filtersToSql({ $or: [{ status: 'active' }] });
    expect(where).toBe(`${field('status')} = ?`);
  });

  it('$and with a single branch does not double-wrap in parentheses', () => {
    const { where } = filtersToSql({ $and: [{ active: true }] });
    expect(where).toBe(`${field('active')} = ?`);
  });

  it('deeply nested field path', () => {
    const { where, params } = filtersToSql(filters({ 'a.b.c': 42 }));
    expect(where).toBe(`${field('a.b.c')} = ?`);
    expect(params).toEqual([42]);
  });
});
