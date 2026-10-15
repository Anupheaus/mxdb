import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Record } from '@anupheaus/common';
import { defineCollection } from '../../common/defineCollection';
import { CLIENT_REQUEST_REFUSED_MESSAGE, refuseServerOnlyCollections } from './refuseServerOnlyCollections';

const h = vi.hoisted(() => ({ warn: vi.fn(), collections: new Map<string, unknown>() }));

vi.mock('@anupheaus/nexus/server', async importOriginal => ({
  ...(await importOriginal<object>()),
  useLogger: () => ({ warn: h.warn }),
}));

vi.mock('../providers', () => ({
  // `ServerDb.use` answers undefined for a name it does not register.
  useDb: () => ({ use: (name: string) => h.collections.get(name) }),
}));

const tokens = defineCollection<Record>({ name: 'refuse_tokens', indexes: [], syncMode: 'ServerOnly' });
const items = defineCollection<Record>({ name: 'refuse_items', indexes: [] });

beforeEach(() => {
  h.warn.mockReset();
  h.collections.clear();
  h.collections.set(tokens.name, { collection: tokens });
  h.collections.set(items.name, { collection: items });
});

describe('refuseServerOnlyCollections', () => {
  it('refuses a request naming a server-only collection, and logs a warning naming the collection only', () => {
    const request = { collectionName: tokens.name, ids: ['secret-id'] };
    expect(() => refuseServerOnlyCollections({ requestName: 'mxdbGetAction', request })).toThrow(CLIENT_REQUEST_REFUSED_MESSAGE);
    expect(h.warn).toHaveBeenCalledTimes(1);
    const [, meta] = h.warn.mock.calls[0]!;
    expect(meta).toEqual({ requestName: 'mxdbGetAction', collectionNames: [tokens.name], securityEvent: 'server-only-collection-refused' });
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain('secret-id');
  });

  it('refuses the whole of a sync request when any collection it names is server-only', () => {
    const request = [{ collectionName: items.name, records: [] }, { collectionName: tokens.name, records: [] }];
    expect(() => refuseServerOnlyCollections({ requestName: 'mxdbClientToServerSyncAction', request })).toThrow(CLIENT_REQUEST_REFUSED_MESSAGE);
  });

  it('gives the same refusal whatever the server-only collection holds, so it reveals nothing about a record', () => {
    const errorFor = (ids: string[]): unknown => {
      try { refuseServerOnlyCollections({ requestName: 'mxdbGetAction', request: { collectionName: tokens.name, ids } }); } catch (error) { return error; }
    };
    expect(String(errorFor(['exists']))).toBe(String(errorFor(['never-existed'])));
  });

  it('lets a synchronised collection through, and an unknown one (handled as before)', () => {
    expect(() => refuseServerOnlyCollections({ requestName: 'mxdbQueryAction', request: { collectionName: items.name } })).not.toThrow();
    expect(() => refuseServerOnlyCollections({ requestName: 'mxdbQueryAction', request: { collectionName: 'not_registered' } })).not.toThrow();
    expect(h.warn).not.toHaveBeenCalled();
  });
});
