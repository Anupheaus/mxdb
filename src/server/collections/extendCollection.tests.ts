import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defineCollection } from '../../common/defineCollection';
import {
  extendCollection,
  getCollectionExtensions,
  type CollectionExtensionHooks,
  type OnDeletePayload,
  type OnUpsertPayload,
  type OnClearPayload,
} from './extendCollection';
import type { Record } from '@anupheaus/common';

describe('extendCollection', () => {
  interface TestRecord extends Record {
    id: string;
    name: string;
  }

  let collection: ReturnType<typeof defineCollection<TestRecord>>;

  beforeEach(() => {
    collection = defineCollection<TestRecord>({
      name: 'extend-test',
      indexes: [],
    });
  });

  it('getCollectionExtensions returns undefined when no extensions registered', () => {
    expect(getCollectionExtensions(collection)).toBeUndefined();
  });

  it('getCollectionExtensions returns hooks after extendCollection', () => {
    const hooks: CollectionExtensionHooks<TestRecord> = {
      onBeforeDelete: async () => {},
      onAfterUpsert: async () => {},
    };
    extendCollection(collection, hooks);
    const ext = getCollectionExtensions(collection);
    expect(ext).toBeDefined();
    expect(ext!.onBeforeDelete).toBe(hooks.onBeforeDelete);
    expect(ext!.onAfterUpsert).toBe(hooks.onAfterUpsert);
  });

  it('merge new hooks with existing when extending again', () => {
    extendCollection(collection, { onBeforeDelete: async () => {} });
    const onAfterUpsert = async (_: OnUpsertPayload<TestRecord>) => {};
    extendCollection(collection, { onAfterUpsert });
    const ext = getCollectionExtensions(collection);
    expect(ext!.onBeforeDelete).toBeDefined();
    expect(ext!.onAfterUpsert).toBe(onAfterUpsert);
  });

  it('onSeed can be registered and retrieved', () => {
    const onSeed = async () => {};
    extendCollection(collection, { onSeed });
    expect(getCollectionExtensions(collection)!.onSeed).toBe(onSeed);
  });

  it('OnDeletePayload has recordIds', () => {
    const payload: OnDeletePayload = { recordIds: ['a', 'b'] };
    expect(payload.recordIds).toEqual(['a', 'b']);
  });

  it('OnUpsertPayload has records, insertedIds, updatedIds', () => {
    const records = [{ id: '1', name: 'x' }];
    const payload: OnUpsertPayload<TestRecord> = {
      records,
      insertedIds: ['1'],
      updatedIds: [],
    };
    expect(payload.records).toEqual(records);
    expect(payload.insertedIds).toEqual(['1']);
    expect(payload.updatedIds).toEqual([]);
  });

  it('OnClearPayload has collectionName', () => {
    const payload: OnClearPayload = { collectionName: 'foo' };
    expect(payload.collectionName).toBe('foo');
  });

  it('returns undefined extensions when collection was never extended', () => {
    const fresh = defineCollection({ name: 'never-extended', indexes: [] });
    expect(getCollectionExtensions(fresh)).toBeUndefined();
  });

  it('merges hooks from two extendCollection calls on the same collection', () => {
    const coll = defineCollection({ name: 'merge-test', indexes: [] });
    const onBeforeUpsert = vi.fn();
    const onAfterUpsert = vi.fn();
    extendCollection(coll, { onBeforeUpsert });
    extendCollection(coll, { onAfterUpsert });
    const ext = getCollectionExtensions(coll);
    expect(ext?.onBeforeUpsert).toBe(onBeforeUpsert);
    expect(ext?.onAfterUpsert).toBe(onAfterUpsert);
  });
});
