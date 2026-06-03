import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleQuery } from './queryAction';

function withIds<T extends { id: string }>(items: T[]): T[] & { ids: () => string[] } {
  return Object.assign(items, { ids: () => items.map(r => r.id) });
}

const mockUseDb = vi.fn();
const mockUseServerToClientSynchronisation = vi.fn();

vi.mock('../providers', () => ({
  useDb: () => mockUseDb(),
  useServerToClientSynchronisation: () => mockUseServerToClientSynchronisation(),
}));

describe('handleQuery', () => {
  const collection = { name: 'items' };
  const mockQuery = vi.fn();
  const mockDbCollection = { collection, query: mockQuery };
  const mockPushActive = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDb.mockReturnValue({ use: () => mockDbCollection });
    mockUseServerToClientSynchronisation.mockReturnValue({ pushActive: mockPushActive });
  });

  it('returns empty array when query returns no records', async () => {
    mockQuery.mockResolvedValue({ data: [], total: 0 });
    const result = await handleQuery({ collectionName: 'items' });
    expect(result).toEqual([]);
  });

  it('calls pushActive and returns total', async () => {
    const records = withIds([{ id: '1', name: 'a' }]);
    mockQuery.mockResolvedValue({ data: records, total: 1 });
    const result = await handleQuery({ collectionName: 'items' });
    expect(mockPushActive).toHaveBeenCalledWith('items', records);
    expect(result).toBe(1);
  });

  it('does not call pushActive when no records returned', async () => {
    mockQuery.mockResolvedValue({ data: [], total: 0 });
    await handleQuery({ collectionName: 'items' });
    expect(mockPushActive).not.toHaveBeenCalled();
  });

  it('passes extra query parameters to dbCollection.query', async () => {
    mockQuery.mockResolvedValue({ data: [], total: 0 });
    await handleQuery({ collectionName: 'items', filters: { active: true }, limit: 10 });
    expect(mockQuery).toHaveBeenCalledWith({ filters: { active: true }, limit: 10 });
  });

  it('propagates rejection when query throws', async () => {
    mockQuery.mockRejectedValue(new Error('DB error'));
    await expect(handleQuery({ collectionName: 'items' })).rejects.toThrow('DB error');
    expect(mockPushActive).not.toHaveBeenCalled();
  });

  it('returns 0 and skips pushActive when query returns empty data', async () => {
    mockQuery.mockResolvedValue({ data: [], total: 0 });
    const result = await handleQuery({ collectionName: 'items' });
    expect(result).toEqual([]);
    expect(mockPushActive).not.toHaveBeenCalled();
  });
});
