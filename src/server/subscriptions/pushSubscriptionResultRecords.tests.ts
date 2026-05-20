import { describe, it, expect, vi } from 'vitest';
import type { Record } from '@anupheaus/common';
import type { MXDBCollection } from '../../common';
import type { ServerToClientSynchronisation } from '../ServerToClientSynchronisation';
import { pushSubscriptionResultRecords } from './pushSubscriptionResultRecords';

type TestRecord = { id: string };

function makeS2C() {
  return {
    pushActive: vi.fn().mockResolvedValue(undefined),
    pushDeletes: vi.fn().mockResolvedValue(undefined),
  } as unknown as ServerToClientSynchronisation;
}

const collection = { name: 'items' } as unknown as MXDBCollection<TestRecord>;

describe('pushSubscriptionResultRecords', () => {
  it('does not call pushActive or pushDeletes when both records and removedIds are empty', async () => {
    const s2c = makeS2C();

    await pushSubscriptionResultRecords(s2c, collection, []);

    expect(s2c.pushActive).not.toHaveBeenCalled();
    expect(s2c.pushDeletes).not.toHaveBeenCalled();
  });

  it('calls pushActive with the collection name and records when only records are provided', async () => {
    const s2c = makeS2C();
    const records: TestRecord[] = [{ id: 'r1' }];

    await pushSubscriptionResultRecords(s2c, collection, records);

    expect(s2c.pushActive).toHaveBeenCalledOnce();
    expect(s2c.pushActive).toHaveBeenCalledWith('items', [{ id: 'r1' }]);
    expect(s2c.pushDeletes).not.toHaveBeenCalled();
  });

  it('calls pushDeletes with the collection name and ids when only removedIds are provided', async () => {
    const s2c = makeS2C();

    await pushSubscriptionResultRecords(s2c, collection, [], ['id1', 'id2']);

    expect(s2c.pushDeletes).toHaveBeenCalledOnce();
    expect(s2c.pushDeletes).toHaveBeenCalledWith('items', ['id1', 'id2']);
    expect(s2c.pushActive).not.toHaveBeenCalled();
  });

  it('calls both pushActive and pushDeletes when records and removedIds are both provided', async () => {
    const s2c = makeS2C();
    const records: TestRecord[] = [{ id: 'r1' }];

    await pushSubscriptionResultRecords(s2c, collection, records, ['id2']);

    expect(s2c.pushActive).toHaveBeenCalledOnce();
    expect(s2c.pushActive).toHaveBeenCalledWith('items', [{ id: 'r1' }]);
    expect(s2c.pushDeletes).toHaveBeenCalledOnce();
    expect(s2c.pushDeletes).toHaveBeenCalledWith('items', ['id2']);
  });
});
