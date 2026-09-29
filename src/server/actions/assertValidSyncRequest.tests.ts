import { describe, it, expect } from 'vitest';
import { ArgumentInvalidError } from '@anupheaus/common';
import { assertValidSyncRequest } from './assertValidSyncRequest';

describe('assertValidSyncRequest', () => {
  const valid = [{ collectionName: 'notes', records: [{ id: 'n1', hash: 'h', entries: [] }, { id: 'n2', entries: [] }] }];

  it('accepts what a client sends: string ids, a string or absent hash, an entries array', () => {
    expect(() => assertValidSyncRequest(valid)).not.toThrow();
    expect(() => assertValidSyncRequest([])).not.toThrow();
  });

  it.each([
    ['a request that is not an array', { collectionName: 'notes' }],
    ['a missing collection name', [{ records: [] }]],
    ['records that are not an array', [{ collectionName: 'notes', records: {} }]],
    ['an operator object as a record id', [{ collectionName: 'notes', records: [{ id: { $gt: '' }, entries: [] }] }]],
    ['an empty record id', [{ collectionName: 'notes', records: [{ id: '', entries: [] }] }]],
    ['a numeric record id', [{ collectionName: 'notes', records: [{ id: 42, entries: [] }] }]],
    ['a hash that is not a string', [{ collectionName: 'notes', records: [{ id: 'n1', hash: { $ne: null }, entries: [] }] }]],
    ['entries that are not an array', [{ collectionName: 'notes', records: [{ id: 'n1', entries: 'x' }] }]],
  ])('refuses %s', (_case, request) => {
    expect(() => assertValidSyncRequest(request)).toThrow(ArgumentInvalidError);
  });
});
