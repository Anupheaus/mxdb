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

  // ─── Callback failures ───────────────────────────────────────────────────────

  /** Let a rejected callback promise's catch handler run. Timer-free. */
  async function flushMicrotasks(): Promise<void> {
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
  }

  const asyncRejections: Array<[string, string, 'debug' | 'error']> = [
    ['a socket disconnect (expected during teardown)', 'socket has been disconnected', 'debug'],
    ['a transport close (expected during teardown)', 'transport close', 'debug'],
    ['any other failure', 'query exploded', 'error'],
  ];

  it.each(asyncRejections)('logs an async callback rejection caused by %s at %s level instead of leaking it', async (_label, message, level) => {
    const result = useCollection('items');
    result.onChange('sub-async', async () => { throw new Error(message); });

    onChangeCallback!({ collectionName: 'items' });
    await flushMicrotasks();

    // An escaped rejection would fail the run as an unhandled rejection; the log proves it was caught.
    expect(mockLogger[level]).toHaveBeenCalledWith(expect.stringContaining('onChange callback rejected'),
      { collectionName: 'items', subscriptionId: 'sub-async', error: message });
  });

  it('logs a non-Error rejection by its string form', async () => {
    const result = useCollection('items');
    result.onChange(() => Promise.reject('plain string'));

    onChangeCallback!({ collectionName: 'items' });
    await flushMicrotasks();

    expect(mockLogger.error).toHaveBeenCalledWith('onChange callback rejected',
      { collectionName: 'items', subscriptionId: undefined, error: 'plain string' });
  });

  it('does not let a synchronously throwing callback break the change stream', () => {
    const result = useCollection('items');
    result.onChange('sub-sync', () => { throw new Error('sync boom'); });

    expect(() => onChangeCallback!({ collectionName: 'items' })).not.toThrow();
  });

  it('logs a synchronously throwing callback', () => {
    const result = useCollection('items');
    result.onChange('sub-sync', () => { throw new Error('sync boom'); });

    onChangeCallback!({ collectionName: 'items' });

    expect(mockLogger.error).toHaveBeenCalledWith('onChange callback threw synchronously',
      { collectionName: 'items', subscriptionId: 'sub-sync', error: 'sync boom' });
  });

  // ─── onChange registration contract ─────────────────────────────────────────

  it('returns an unsubscribe function for an anonymous watch', () => {
    const result = useCollection('items');

    const unsubscribe = result.onChange(vi.fn());

    expect(unsubscribe).toBe(mockUnsubscribe);
  });

  it('throws when no callback is supplied', () => {
    const result = useCollection('items');

    expect(() => (result.onChange as unknown as (id: string) => void)('sub-without-callback'))
      .toThrow('Callback is required to subscribe to changes for this collection');
  });

  it('ignores removal of a watch id that was never registered', () => {
    const result = useCollection('items');

    result.removeOnChange('never-registered');

    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });

  it('only unsubscribes a named watch once even if removed twice', () => {
    const result = useCollection('items');
    result.onChange('sub-twice', vi.fn());

    result.removeOnChange('sub-twice');
    result.removeOnChange('sub-twice');

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
