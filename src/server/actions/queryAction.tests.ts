import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueryProps } from '../../common';
import { extendCollection } from '../collections/extendCollection';
import { handleQuery } from './queryAction';

function withIds<T extends { id: string }>(items: T[]): T[] & { ids: () => string[] } {
  return Object.assign(items, { ids: () => items.map(r => r.id) });
}

const mockUseDb = vi.fn();
const mockUseServerToClientSynchronisation = vi.fn();

const auth = vi.hoisted(() => ({ user: undefined as { id: string } | undefined, throws: false }));

vi.mock('@anupheaus/nexus/server', async importOriginal => ({
  ...(await importOriginal<object>()),
  useAuthentication: () => {
    if (auth.throws) throw new Error('no auth context');
    return { user: auth.user };
  },
}));

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

// ─── onQuery extension hook (server-side scoping) ─────────────────────────────

describe('handleQuery — onQuery extension hook', () => {
  type OnQuery = (payload: { request: QueryProps<{ id: string }>; userId: string | undefined }) =>
    QueryProps<{ id: string }> | void | Promise<QueryProps<{ id: string }> | void>;

  const mockQuery = vi.fn();
  const mockPushActive = vi.fn();
  let collection: { name: string; type: unknown };

  /** A fresh collection token per test so hooks registered by one test never leak into another. */
  function useCollectionWithHook(onQuery: OnQuery): void {
    collection = { name: 'items', type: null };
    extendCollection(collection as never, { onQuery: onQuery as never });
    mockUseDb.mockReturnValue({ use: () => ({ collection, query: mockQuery }) });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = { id: 'user-1' };
    auth.throws = false;
    mockQuery.mockResolvedValue({ data: withIds([{ id: 'r1' }]), total: 1 });
    mockUseServerToClientSynchronisation.mockReturnValue({ pushActive: mockPushActive });
  });

  it('executes the request returned by the hook instead of the client request', async () => {
    useCollectionWithHook(() => ({ filters: { tenantId: 't1' } } as unknown as QueryProps<{ id: string }>));

    await handleQuery({ collectionName: 'items', filters: { active: true } });

    expect(mockQuery).toHaveBeenCalledWith({ filters: { tenantId: 't1' } });
  });

  it('executes the client request unchanged when the hook returns nothing', async () => {
    useCollectionWithHook(async () => undefined);

    await handleQuery({ collectionName: 'items', filters: { active: true } });

    expect(mockQuery).toHaveBeenCalledWith({ filters: { active: true } });
  });

  it('gives the hook the client request without the collection name', async () => {
    const onQuery = vi.fn<OnQuery>(() => undefined);
    useCollectionWithHook(onQuery);

    await handleQuery({ collectionName: 'items', filters: { active: true }, serverHints: { scope: 'mine' } });

    expect(onQuery.mock.calls[0]![0].request).toEqual({ filters: { active: true }, serverHints: { scope: 'mine' } });
  });

  const authCases: Array<[string, { id: string } | undefined, boolean, string | undefined]> = [
    ['an authenticated user', { id: 'user-42' }, false, 'user-42'],
    ['an unauthenticated connection', undefined, false, undefined],
    ['no authentication context at all', { id: 'ignored' }, true, undefined],
  ];

  it.each(authCases)('gives the hook the user id for %s', async (_label, user, throws, expectedUserId) => {
    auth.user = user;
    auth.throws = throws;
    const onQuery = vi.fn<OnQuery>(() => undefined);
    useCollectionWithHook(onQuery);

    await handleQuery({ collectionName: 'items' });

    expect(onQuery.mock.calls[0]![0].userId).toBe(expectedUserId);
  });

  it('rejects without querying when the hook throws (fails closed)', async () => {
    useCollectionWithHook(() => { throw new Error('forbidden'); });

    await expect(handleQuery({ collectionName: 'items' })).rejects.toThrow('forbidden');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('skips the hook entirely when the db collection has no collection definition', async () => {
    mockUseDb.mockReturnValue({ use: () => ({ collection: undefined, query: mockQuery }) });

    await handleQuery({ collectionName: 'items', filters: { active: true } });

    expect(mockQuery).toHaveBeenCalledWith({ filters: { active: true } });
  });
});
