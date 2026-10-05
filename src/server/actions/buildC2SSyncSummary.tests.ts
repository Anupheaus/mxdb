import { describe, it, expect } from 'vitest';
import { buildC2SSyncSummary, type C2SSyncCollectionResult } from './buildC2SSyncSummary';

function result(overrides: Partial<C2SSyncCollectionResult>): C2SSyncCollectionResult {
  return { collectionName: 'items', upserted: 0, deleted: 0, conflicts: 0, rejected: 0, failed: 0, ...overrides };
}

describe('buildC2SSyncSummary', () => {
  it('returns nothing for a sync that wrote nothing', () => {
    expect(buildC2SSyncSummary([])).toBeUndefined();
  });

  it('returns nothing when every change was rejected or failed (nothing was written)', () => {
    expect(buildC2SSyncSummary([result({ rejected: 2, failed: 1 })])).toBeUndefined();
  });

  it('totals the counts across collections and lists each collection that had activity', () => {
    const summary = buildC2SSyncSummary([
      result({ collectionName: 'items', upserted: 2, deleted: 1, conflicts: 1 }),
      result({ collectionName: 'tasks', rejected: 1, failed: 1 }),
      result({ collectionName: 'idle' }),
    ]);

    expect(summary).toEqual({
      upserted: 2,
      deleted: 1,
      conflicts: 1,
      rejected: 1,
      failed: 1,
      collections: [
        { collectionName: 'items', upserted: 2, deleted: 1, conflicts: 1, rejected: 0, failed: 0 },
        { collectionName: 'tasks', upserted: 0, deleted: 0, conflicts: 0, rejected: 1, failed: 1 },
      ],
    });
  });

  it('merges results reported twice for the same collection', () => {
    const summary = buildC2SSyncSummary([
      result({ upserted: 1 }),
      result({ upserted: 2, rejected: 1 }),
    ]);

    expect(summary?.collections).toEqual([{ collectionName: 'items', upserted: 3, deleted: 0, conflicts: 0, rejected: 1, failed: 0 }]);
  });
});
