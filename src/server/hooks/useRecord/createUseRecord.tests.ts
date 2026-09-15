import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUseRecord } from './createUseRecord';

const mockGet = vi.fn();
const mockUpsert = vi.fn();
const mockRemove = vi.fn();
const mockGetAll = vi.fn();
const mockFind = vi.fn();
const mockQuery = vi.fn();
const mockDistinct = vi.fn();

vi.mock('../../collections/useCollection', () => ({
  useCollection: () => ({
    get: mockGet,
    upsert: mockUpsert,
    remove: mockRemove,
    getAll: mockGetAll,
    find: mockFind,
    query: mockQuery,
    distinct: mockDistinct,
  }),
}));

describe('createUseRecord (server)', () => {
  const collection = { name: 'orders', type: {} as any };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(undefined);
    mockRemove.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({ data: [], total: 0 });
  });

  it('calls hydrateRecord with the loaded record', async () => {
    const hydrateRecord = vi.fn().mockImplementation((r: any) => r ?? { id: '', name: 'New' });
    const useOrder = createUseRecord('order', collection, { hydrateRecord });
    const existing = { id: '1', name: 'Existing' };
    mockGet.mockResolvedValue(existing);
    await useOrder('1');
    expect(hydrateRecord).toHaveBeenCalledWith(existing);
  });

  it('calls hydrateRecord with undefined when id is undefined', async () => {
    const hydrateRecord = vi.fn().mockReturnValue({ id: '', name: 'New' });
    const useOrder = createUseRecord('order', collection, { hydrateRecord });
    await useOrder(undefined);
    expect(mockGet).not.toHaveBeenCalled();
    expect(hydrateRecord).toHaveBeenCalledWith(undefined);
  });

  it('isNewOrder is true when record not found', async () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: 'New' },
    });
    const result = await useOrder('missing-id');
    expect(result.isNewOrder).toBe(true);
  });

  it('isNewOrder is false when record exists', async () => {
    mockGet.mockResolvedValue({ id: '1', name: 'Existing' });
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r!,
    });
    const result = await useOrder('1');
    expect(result.isNewOrder).toBe(false);
  });

  it('stamps id onto the hydrated record', async () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: () => ({ id: '', name: 'New' }),
    });
    const result = await useOrder('target-id');
    expect(result.order?.id).toBe('target-id');
  });

  it('removeOrder calls remove with the hydrated record', async () => {
    const existing = { id: '1', name: 'Existing' };
    mockGet.mockResolvedValue(existing);
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r!,
    });
    const result = await useOrder('1');
    await result.removeOrder();
    expect(mockRemove).toHaveBeenCalledWith(existing);
  });

  it('removeOrder returns false when record is undefined', async () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: () => undefined as any,
    });
    const result = await useOrder('1');
    const removed = await result.removeOrder();
    expect(removed).toBe(false);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('merges helper results into the returned object', async () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: 'New' },
      helpers: ctx => ({ isSpecial: ctx.order?.name === 'Special' }),
    });
    mockGet.mockResolvedValue({ id: '1', name: 'Special' });
    const result = await useOrder('1');
    expect((result as any).isSpecial).toBe(true);
  });

  it('passes extra args through to hydrateRecord', async () => {
    const hydrateRecord = vi.fn().mockReturnValue({ id: '', name: '' });
    mockGet.mockResolvedValue({ id: '1', name: 'Existing' });
    const useOrder = createUseRecord('order', collection, { hydrateRecord });
    await useOrder('1', 'extra-arg' as any);
    expect(hydrateRecord).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }), 'extra-arg');
  });

  it('attaches extensions as static methods', () => {
    const staticFn = vi.fn().mockReturnValue('hello');
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
      extensions: { getDefault: staticFn },
    });
    expect(typeof (useOrder as any).getDefault).toBe('function');
    (useOrder as any).getDefault();
    expect(staticFn).toHaveBeenCalled();
  });

  // ─── Static get ──────────────────────────────────────────────────────────

  it('static get with a single id delegates to col.get', async () => {
    mockGet.mockResolvedValue({ id: '1', name: 'A' });
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const result = await useOrder.get('1');
    expect(mockGet).toHaveBeenCalledWith('1');
    expect(result).toEqual({ id: '1', name: 'A' });
  });

  it('static get returns undefined when record not found', async () => {
    mockGet.mockResolvedValue(undefined);
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const result = await useOrder.get('missing');
    expect(result).toBeUndefined();
  });

  it('static get with an array of ids returns array of records', async () => {
    mockGet.mockResolvedValue([{ id: '1' }, { id: '2' }]);
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const result = await useOrder.get(['1', '2']);
    expect(mockGet).toHaveBeenCalledWith(['1', '2']);
    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
  });

  // ─── Static getAll ────────────────────────────────────────────────────────

  it('static getAll delegates to col.getAll', async () => {
    mockGetAll.mockResolvedValue([{ id: '1' }, { id: '2' }]);
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const result = await useOrder.getAll();
    expect(mockGetAll).toHaveBeenCalled();
    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('static getAll returns empty array when collection is empty', async () => {
    mockGetAll.mockResolvedValue([]);
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const result = await useOrder.getAll();
    expect(result).toEqual([]);
  });

  // ─── Static find ─────────────────────────────────────────────────────────

  it('static find delegates to col.find with the given filters', async () => {
    mockFind.mockResolvedValue({ id: '1', status: 'active' });
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const result = await useOrder.find({ status: 'active' } as any);
    expect(mockFind).toHaveBeenCalledWith({ status: 'active' });
    expect(result).toEqual({ id: '1', status: 'active' });
  });

  it('static find returns undefined when no match', async () => {
    mockFind.mockResolvedValue(undefined);
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const result = await useOrder.find({ status: 'gone' } as any);
    expect(result).toBeUndefined();
  });

  // ─── Static query ─────────────────────────────────────────────────────────

  it('static query returns array of records', async () => {
    mockQuery.mockResolvedValue({ data: [{ id: '1' }, { id: '2' }], total: 2 });
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const result = await useOrder.query();
    expect(mockQuery).toHaveBeenCalledWith({});
    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('static query passes QueryProps to col.query', async () => {
    mockQuery.mockResolvedValue({ data: [], total: 0 });
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    await useOrder.query({ filters: { status: 'active' } as any });
    expect(mockQuery).toHaveBeenCalledWith({ filters: { status: 'active' } });
  });

  it('static query returns empty array when no records match', async () => {
    mockQuery.mockResolvedValue({ data: [], total: 0 });
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const result = await useOrder.query({ filters: { status: 'gone' } as any });
    expect(result).toEqual([]);
  });

  // ─── Static distinct ──────────────────────────────────────────────────────

  it('static distinct delegates to col.distinct with field', async () => {
    mockDistinct.mockResolvedValue([{ id: '1', status: 'pending' }, { id: '2', status: 'active' }, { id: '3', status: 'closed' }]);
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const result = await useOrder.distinct('status' as any);
    expect(mockDistinct).toHaveBeenCalledWith({ field: 'status' });
    expect(result).toEqual(['pending', 'active', 'closed']);
  });

  it('static distinct passes filters props to col.distinct', async () => {
    mockDistinct.mockResolvedValue([{ id: '1', status: 'active' }]);
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    await useOrder.distinct('status' as any, { filters: { active: true } as any });
    expect(mockDistinct).toHaveBeenCalledWith({ field: 'status', filters: { active: true } });
  });
});
