import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { dbUtils } from './db-transforms';
import type { Record } from '@anupheaus/common';
import type { MongoDocOf } from '../../../common';

describe('dbUtils', () => {

  // Regression: DateTime fields must persist as native BSON `Date`s (not ISO strings) so that
  // MongoDB `$lt`/`$gt` range queries — whose bounds are converted to `Date` — actually match.
  describe('DateTime storage', () => {
    it('serializes a DateTime field to a native Date (queryable in MongoDB)', () => {
      const start = DateTime.fromISO('2026-06-11T09:00:00.000Z', { zone: 'utc' });
      const serialized = dbUtils.serialize({ id: 'a1', start } as unknown as Record) as MongoDocOf<Record> & { start: unknown };
      expect(serialized.start).toBeInstanceOf(Date);
      expect((serialized.start as Date).toISOString()).toBe('2026-06-11T09:00:00.000Z');
      expect(typeof serialized.start).not.toBe('string');
    });

    it('serializes nested DateTime fields to Dates too', () => {
      const at = DateTime.fromISO('2026-01-02T03:04:05.000Z', { zone: 'utc' });
      const serialized = dbUtils.serialize({ id: 'a2', meta: { at } } as unknown as Record) as MongoDocOf<Record> & { meta: { at: unknown } };
      expect(serialized.meta.at).toBeInstanceOf(Date);
    });

    it('deserializes a stored Date back into a DateTime', () => {
      const wire = { _id: 'a3', start: new Date('2026-06-11T09:00:00.000Z') } as unknown as MongoDocOf<Record>;
      const result = dbUtils.deserialize(wire) as Record & { start: unknown };
      expect(DateTime.isDateTime(result.start)).toBe(true);
      expect((result.start as DateTime).toUTC().toISO()).toBe('2026-06-11T09:00:00.000Z');
    });

    it('round-trips a DateTime through serialize + deserialize preserving the instant', () => {
      const start = DateTime.fromISO('2026-06-11T13:30:00.000Z', { zone: 'utc' });
      const result = dbUtils.deserialize(dbUtils.serialize({ id: 'a4', start } as unknown as Record)) as Record & { start: unknown };
      expect(DateTime.isDateTime(result.start)).toBe(true);
      expect((result.start as DateTime).toMillis()).toBe(start.toMillis());
    });

    it('revives legacy ISO-string dates into DateTimes on deserialize', () => {
      const wire = { _id: 'a5', start: '2026-06-11T09:00:00.000Z' } as unknown as MongoDocOf<Record>;
      const result = dbUtils.deserialize(wire) as Record & { start: unknown };
      expect(DateTime.isDateTime(result.start)).toBe(true);
      expect((result.start as DateTime).toUTC().toISO()).toBe('2026-06-11T09:00:00.000Z');
    });
  });

  describe('serialize', () => {
    it('replaces id with _id for MongoDB', () => {
      const record = { id: 'abc-123', name: 'foo' } as Record;
      const serialized = dbUtils.serialize(record);
      expect(serialized).toHaveProperty('_id', 'abc-123');
      expect(serialized).not.toHaveProperty('id');
      expect(serialized).toHaveProperty('name', 'foo');
    });

    it('preserves other fields', () => {
      const record = { id: '1', a: 1, b: 'two', c: true } as Record;
      const serialized = dbUtils.serialize(record) as MongoDocOf<Record> & { a: number; b: string; c: boolean };
      expect(serialized._id).toBe('1');
      expect(serialized.a).toBe(1);
      expect(serialized.b).toBe('two');
      expect(serialized.c).toBe(true);
    });
  });

  describe('deserialize', () => {
    it('replaces _id with id', () => {
      const wire = { _id: 'xyz', name: 'bar' } as MongoDocOf<Record>;
      const deserialized = dbUtils.deserialize(wire);
      expect(deserialized).toHaveProperty('id', 'xyz');
      expect(deserialized).not.toHaveProperty('_id');
      expect(deserialized).toHaveProperty('name', 'bar');
    });

    it('returns undefined for null/undefined', () => {
      expect(dbUtils.deserialize(undefined)).toBeUndefined();
      expect(dbUtils.deserialize(null as any)).toBeUndefined();
    });

    it('round-trips with serialize', () => {
      const record = { id: 'round-trip', value: 42 } as Record;
      const serialized = dbUtils.serialize(record);
      const deserialized = dbUtils.deserialize(serialized);
      expect(deserialized).toEqual(record);
    });

    it('preserves nested objects on deserialize', () => {
      const wire = { _id: 'n1', address: { city: 'London' } } as MongoDocOf<Record>;
      const result = dbUtils.deserialize(wire);
      expect(result).toEqual({ id: 'n1', address: { city: 'London' } });
    });
  });

  describe('serialize edge cases', () => {
    it('preserves nested objects on serialize', () => {
      const record = { id: 's1', meta: { tags: ['a', 'b'] } } as Record;
      const serialized = dbUtils.serialize(record) as MongoDocOf<Record> & { meta: { tags: string[] } };
      expect(serialized.meta).toEqual({ tags: ['a', 'b'] });
    });

    it('handles record with only an id', () => {
      const record = { id: 'only-id' } as Record;
      const serialized = dbUtils.serialize(record);
      expect(serialized._id).toBe('only-id');
      const keys = Object.keys(serialized).filter(k => k !== '_id');
      expect(keys.length).toBe(0);
    });

    it('handles id with special characters', () => {
      const record = { id: 'org:123/dept~45' } as Record;
      const serialized = dbUtils.serialize(record);
      expect(serialized._id).toBe('org:123/dept~45');
      const deserialized = dbUtils.deserialize(serialized);
      expect(deserialized!.id).toBe('org:123/dept~45');
    });

    it('preserves array-valued fields on serialize', () => {
      const record = { id: 's2', tags: ['a', 'b', 'c'] } as Record;
      const serialized = dbUtils.serialize(record) as MongoDocOf<Record> & { tags: string[] };
      expect(serialized.tags).toEqual(['a', 'b', 'c']);
    });
  });

  describe('deserialize edge cases', () => {
    it('preserves all extra properties on deserialize', () => {
      const wire = { _id: 'e1', a: 1, b: 'two', nested: { x: 42 } } as MongoDocOf<Record>;
      const result = dbUtils.deserialize(wire) as Record & { a: number; b: string; nested: { x: number } };
      expect(result.id).toBe('e1');
      expect(result.a).toBe(1);
      expect(result.b).toBe('two');
      expect(result.nested).toEqual({ x: 42 });
    });
  });
});
