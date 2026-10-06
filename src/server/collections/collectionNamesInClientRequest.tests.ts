import { describe, it, expect } from 'vitest';
import { collectionNamesInClientRequest } from './collectionNamesInClientRequest';

describe('collectionNamesInClientRequest', () => {
  it('reads the one collection a get, getAll, query or distinct request (or subscription) names', () => {
    expect(collectionNamesInClientRequest({ collectionName: 'items', ids: ['1'] })).toEqual(['items']);
    expect(collectionNamesInClientRequest({ collectionName: 'items', filters: {} })).toEqual(['items']);
  });

  it('reads every collection a sync or reconcile request names, once each', () => {
    const request = [
      { collectionName: 'items', records: [] },
      { collectionName: 'tokens', localIds: ['1'] },
      { collectionName: 'items', records: [] },
    ];
    expect(collectionNamesInClientRequest(request)).toEqual(['items', 'tokens']);
  });

  it('ignores what names no collection: a request with no name, a non-string name, or no request at all', () => {
    expect(collectionNamesInClientRequest(undefined)).toEqual([]);
    expect(collectionNamesInClientRequest(null)).toEqual([]);
    expect(collectionNamesInClientRequest('items')).toEqual([]);
    expect(collectionNamesInClientRequest({ ids: ['1'] })).toEqual([]);
    expect(collectionNamesInClientRequest({ collectionName: { $ne: '' } })).toEqual([]);
    expect(collectionNamesInClientRequest([null, 3, { collectionName: 'items' }])).toEqual(['items']);
  });
});
