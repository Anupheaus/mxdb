import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Logger } from '@anupheaus/common';
import type { Record } from '@anupheaus/common';
import { createRemove } from './createRemove';

interface Row extends Record {
  id: string;
  name: string;
}

describe('createRemove', () => {
  const logger = new Logger('test');
  let mockDelete: ReturnType<typeof vi.fn>;
  let mockRemoveAuditTrail: ReturnType<typeof vi.fn>;
  let mockNotifyRemove: ReturnType<typeof vi.fn>;
  let mockDbCollection: any;

  beforeEach(() => {
    mockDelete = vi.fn().mockResolvedValue(undefined);
    mockRemoveAuditTrail = vi.fn().mockResolvedValue(undefined);
    mockNotifyRemove = vi.fn();
    mockDbCollection = {
      name: 'items',
      delete: mockDelete,
      removeAuditTrail: mockRemoveAuditTrail,
      notifyRemove: mockNotifyRemove,
    };
  });

  it('removes by single string id', async () => {
    const remove = createRemove<Row>(mockDbCollection, logger);
    await remove('r1');
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith(['r1'], undefined);
  });

  it('removes by array of string ids', async () => {
    const remove = createRemove<Row>(mockDbCollection, logger);
    await remove(['r1', 'r2']);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith(['r1', 'r2'], undefined);
  });

  it('removes by record object, extracting the id', async () => {
    const remove = createRemove<Row>(mockDbCollection, logger);
    const record: Row = { id: 'r1', name: 'Alice' };
    await remove(record);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith(['r1'], undefined);
  });

  it('removes by array of records, extracting each id', async () => {
    const remove = createRemove<Row>(mockDbCollection, logger);
    const records: Row[] = [
      { id: 'r1', name: 'Alice' },
      { id: 'r2', name: 'Bob' },
    ];
    await remove(records);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith(['r1', 'r2'], undefined);
  });

  it('is a no-op for an empty array and does not call delete', async () => {
    const remove = createRemove<Row>(mockDbCollection, logger);
    await remove([]);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockNotifyRemove).not.toHaveBeenCalled();
  });

  it('in normal mode calls notifyRemove with markAsDeleted and does not call removeAuditTrail', async () => {
    const remove = createRemove<Row>(mockDbCollection, logger);
    await remove('r1');
    expect(mockDelete).toHaveBeenCalledWith(['r1'], undefined);
    expect(mockNotifyRemove).toHaveBeenCalledWith(['r1'], 'markAsDeleted');
    expect(mockRemoveAuditTrail).not.toHaveBeenCalled();
  });

  it('in locallyOnly mode calls delete with skipAuditAppend, removeAuditTrail, and notifyRemove with remove', async () => {
    const remove = createRemove<Row>(mockDbCollection, logger);
    await remove('r1', { locallyOnly: true });
    expect(mockDelete).toHaveBeenCalledWith(['r1'], { skipAuditAppend: true });
    expect(mockRemoveAuditTrail).toHaveBeenCalledWith(['r1']);
    expect(mockNotifyRemove).toHaveBeenCalledWith(['r1'], 'remove');
  });
});
