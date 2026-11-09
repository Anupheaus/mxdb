import { describe, expect, it } from 'vitest';
import { isStoredMetaOnlyChange } from './isStoredMetaOnlyChange';

describe('isStoredMetaOnlyChange', () => {
  const cases: [label: string, change: Parameters<typeof isStoredMetaOnlyChange>[0], expected: boolean][] = [
    ['an update removing the stored hash', { operationType: 'update', updateDescription: { updatedFields: {}, removedFields: ['_meta.hash'] } }, true],
    ['an update setting the whole stored metadata', { operationType: 'update', updateDescription: { updatedFields: { _meta: { hash: 'h' } }, removedFields: [] } }, true],
    ['an update setting a stored metadata field', { operationType: 'update', updateDescription: { updatedFields: { '_meta.lastAuditEntryId': 'x' } } }, true],
    ['an update of a record field', { operationType: 'update', updateDescription: { updatedFields: { cancelledAt: new Date() }, removedFields: [] } }, false],
    ['an update of a record field and the stored metadata', { operationType: 'update', updateDescription: { updatedFields: { cancelledAt: new Date() }, removedFields: ['_meta.hash'] } }, false],
    ['an update removing a record field', { operationType: 'update', updateDescription: { updatedFields: {}, removedFields: ['cancelledAt'] } }, false],
    ['an update truncating a record list', { operationType: 'update', updateDescription: { updatedFields: { '_meta.hash': 'h' }, truncatedArrays: [{ field: 'userIds' }] } }, false],
    ['an update of a field whose name only starts like it', { operationType: 'update', updateDescription: { updatedFields: { _metadata: 'x' } } }, false],
    ['an update that changed nothing', { operationType: 'update', updateDescription: { updatedFields: {}, removedFields: [] } }, false],
    ['an update with no description', { operationType: 'update' }, false],
    ['a replace (it carries no description: the whole document is new)', { operationType: 'replace' }, false],
    ['an insert', { operationType: 'insert' }, false],
  ];

  it.each(cases)('%s',(_label, change, expected) => {
    expect(isStoredMetaOnlyChange(change)).toBe(expected);
  });
});
