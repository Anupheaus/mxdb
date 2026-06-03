import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Logger } from '@anupheaus/common';
import type { Record } from '@anupheaus/common';
import { createUpsert } from './createUpsert';

interface Row extends Record {
  id: string;
  name: string;
}

describe('createUpsert', () => {
  const logger = new Logger('test');
  let mockUpsert: ReturnType<typeof vi.fn>;
  let mockDbCollection: any;

  beforeEach(() => {
    mockUpsert = vi.fn().mockResolvedValue(undefined);
    mockDbCollection = { name: 'items', upsert: mockUpsert };
  });

  it('calls dbCollection.upsert with a single record', async () => {
    const upsert = createUpsert<Row>(mockDbCollection, logger);
    const record: Row = { id: 'r1', name: 'Alice' };
    await upsert(record);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledWith(record);
  });

  it('calls dbCollection.upsert once per record in an array', async () => {
    const upsert = createUpsert<Row>(mockDbCollection, logger);
    const records: Row[] = [
      { id: 'r1', name: 'Alice' },
      { id: 'r2', name: 'Bob' },
    ];
    await upsert(records);
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(mockUpsert).toHaveBeenCalledWith(records[0]);
    expect(mockUpsert).toHaveBeenCalledWith(records[1]);
  });

  it('is a no-op for an empty array and does not call dbCollection.upsert', async () => {
    const upsert = createUpsert<Row>(mockDbCollection, logger);
    await upsert([]);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('awaits all upserts in parallel via Promise.all', async () => {
    const resolvers: Array<() => void> = [];
    mockUpsert = vi.fn().mockImplementation(
      () => new Promise<void>(resolve => resolvers.push(resolve)),
    );
    mockDbCollection = { name: 'items', upsert: mockUpsert };

    const upsert = createUpsert<Row>(mockDbCollection, logger);
    const records: Row[] = [
      { id: 'r1', name: 'Alice' },
      { id: 'r2', name: 'Bob' },
    ];

    const promise = upsert(records);

    // Both upserts should have been called before either resolves
    expect(mockUpsert).toHaveBeenCalledTimes(2);

    // Resolve all pending promises
    resolvers.forEach(resolve => resolve());
    await promise;

    expect(mockUpsert).toHaveBeenCalledWith(records[0]);
    expect(mockUpsert).toHaveBeenCalledWith(records[1]);
  });
});
