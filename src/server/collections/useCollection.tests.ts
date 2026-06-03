import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUseDb = vi.fn();
const mockUseLogger = vi.fn();

vi.mock('../providers', () => ({
  useDb: () => mockUseDb(),
}));

vi.mock('@anupheaus/nexus/server', () => ({
  useLogger: () => mockUseLogger(),
}));

import { useCollection } from './useCollection';

describe('useCollection', () => {
  const mockUnsubscribe = vi.fn();
  const mockDbOnChange = vi.fn();
  const mockQuery = vi.fn();
  const mockUpsert = vi.fn();
  const mockGet = vi.fn();
  const mockGetAudit = vi.fn();
  const mockFind = vi.fn();
  const mockRemove = vi.fn();
  const mockDistinct = vi.fn();
  const mockClear = vi.fn();
  const mockCount = vi.fn();
  const mockGetAll = vi.fn();
  const mockSync = vi.fn();

  const mockCollection = { name: 'items' };

  const mockDbCollection = {
    name: 'items',
    collection: mockCollection,
    get: mockGet,
    getAudit: mockGetAudit,
    query: mockQuery,
    find: mockFind,
    upsert: mockUpsert,
    remove: mockRemove,
    distinct: mockDistinct,
    clear: mockClear,
    count: mockCount,
    getAll: mockGetAll,
    sync: mockSync,
  };

  const mockLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    silly: vi.fn(),
    createSubLogger: vi.fn().mockReturnThis(),
  };

  let onChangeCallback: ((event: { collectionName: string }) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    onChangeCallback = undefined;

    mockDbOnChange.mockImplementation((cb: (event: { collectionName: string }) => void) => {
      onChangeCallback = cb;
      return mockUnsubscribe;
    });

    mockUseDb.mockReturnValue({
      use: vi.fn().mockReturnValue(mockDbCollection),
      onChange: mockDbOnChange,
    });

    mockUseLogger.mockReturnValue(mockLogger);
  });

  // ─── Collection lookup ───────────────────────────────────────────────────────

  it('looks up collection by name string', () => {
    const db = mockUseDb();
    useCollection('items');
    expect(db.use).toHaveBeenCalledWith('items');
  });

  it('looks up collection by MXDBCollection object', () => {
    const db = mockUseDb();
    useCollection({ name: 'items' } as any);
    expect(db.use).toHaveBeenCalledWith('items');
  });

  // ─── Exposed references ──────────────────────────────────────────────────────

  it('exposes the collection reference', () => {
    const result = useCollection('items');
    expect(result.collection).toBe(mockCollection);
  });

  it('exposes query method bound to dbCollection', () => {
    const result = useCollection('items');
    expect(result.query).toBe(mockDbCollection.query);
  });

  it('exposes upsert method bound to dbCollection', () => {
    const result = useCollection('items');
    expect(result.upsert).toBe(mockDbCollection.upsert);
  });

  // ─── onChange ────────────────────────────────────────────────────────────────

  it('onChange fires for matching collection', () => {
    const result = useCollection('items');
    const callback = vi.fn();
    result.onChange(callback);

    // Simulate db.onChange calling back with a matching event
    expect(onChangeCallback).toBeDefined();
    onChangeCallback!({ collectionName: 'items' });

    expect(callback).toHaveBeenCalledWith({ collectionName: 'items' });
  });

  it('onChange does NOT fire for different collection', () => {
    const result = useCollection('items');
    const callback = vi.fn();
    result.onChange(callback);

    expect(onChangeCallback).toBeDefined();
    onChangeCallback!({ collectionName: 'other' });

    expect(callback).not.toHaveBeenCalled();
  });

  // ─── removeOnChange ──────────────────────────────────────────────────────────

  it('removeOnChange removes a named subscription', () => {
    const result = useCollection('items');
    const callback = vi.fn();

    result.onChange('sub-1', callback);
    result.removeOnChange('sub-1');

    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});
