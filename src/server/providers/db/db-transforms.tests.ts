import { describe, it, expect } from 'vitest';
import { dbUtils } from './db-transforms';
import type { Record } from '@anupheaus/common';
import type { MongoDocOf } from '../../../common';

describe('dbUtils', () => {
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
