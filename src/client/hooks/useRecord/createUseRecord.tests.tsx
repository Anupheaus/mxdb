// @vitest-environment jsdom
import '@anupheaus/common';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useRecord as useMXDBRecord } from '../../useRecord';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createUseRecord } from './createUseRecord';

const mockUseGet = vi.fn();
const mockUseGetAll = vi.fn();
const mockUseQuery = vi.fn();
const mockUseDistinct = vi.fn();

vi.mock('../../useRecord', () => ({
  useRecord: vi.fn(() => ({
    record: undefined,
    isLoading: false,
    upsert: vi.fn(),
    remove: vi.fn(),
  })),
}));

vi.mock('../useCollection/useCollection', () => ({
  useCollection: () => ({
    useGet: mockUseGet,
    useGetAll: mockUseGetAll,
    useQuery: mockUseQuery,
    useDistinct: mockUseDistinct,
  }),
}));

/**
 * Minimal renderHook-style helper using createRoot + act.
 * Returns the latest value exposed by the hook via a ref, and an unmount function.
 */
function renderHook<T>(useHook: () => T): { result: { current: T }; unmount: () => void } {
  let container: HTMLDivElement | null = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  const result = { current: undefined as unknown as T };

  function Probe() {
    result.current = useHook();
    return null;
  }

  act(() => {
    root = createRoot(container!);
    root.render(<Probe />);
  });

  function unmount() {
    act(() => {
      root?.unmount();
      root = null;
    });
    container?.remove();
    container = null;
  }

  return { result, unmount };
}

describe('createUseRecord (client)', () => {
  const collection = { name: 'orders', type: {} as any };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseGet.mockReturnValue({ record: undefined, isLoading: false, error: undefined });
    mockUseGetAll.mockReturnValue({ records: [], isLoading: false, error: undefined });
    mockUseQuery.mockReturnValue({ records: [], isLoading: false, total: 0 });
    mockUseDistinct.mockReturnValue({ values: [], isLoading: false, error: undefined });
  });

  let unmount: (() => void) | undefined;
  afterEach(() => {
    unmount?.();
    unmount = undefined;
  });

  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  it('hydrates a new record when createNew is true', () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: () => ({ id: 'new-id', name: 'New Order' }),
    });
    const { result, unmount: u } = renderHook(() => useOrder(undefined, true));
    unmount = u;
    expect(result.current.order).toMatchObject({ name: 'New Order' });
    expect(result.current.isNewOrder).toBe(true);
  });

  it('returns named upsert, remove, set, and autoSave functions', () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const { result, unmount: u } = renderHook(() => useOrder(undefined));
    unmount = u;
    expect(typeof result.current.upsertOrder).toBe('function');
    expect(typeof result.current.removeOrder).toBe('function');
    expect(typeof result.current.setOrder).toBe('function');
    expect(typeof result.current.autoSaveOrder).toBe('function');
    expect(typeof result.current.isLoadingOrder).toBe('boolean');
    expect(typeof result.current.isNewOrder).toBe('boolean');
  });

  it('attaches extensions as static methods', () => {
    const staticHelper = vi.fn().mockReturnValue('hello');
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
      extensions: { getDefault: staticHelper },
    });
    expect(typeof (useOrder as any).getDefault).toBe('function');
    (useOrder as any).getDefault();
    expect(staticHelper).toHaveBeenCalled();
  });

  it('merges helpers into the result', () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
      helpers: () => ({ isSpecial: true }),
    });
    const { result, unmount: u } = renderHook(() => useOrder(undefined));
    unmount = u;
    expect((result.current as any).isSpecial).toBe(true);
  });

  // ─── Static get hook ─────────────────────────────────────────────────────

  it('get static hook returns named record, isLoading, and error', () => {
    mockUseGet.mockReturnValue({ record: { id: '1', name: 'A' }, isLoading: false, error: undefined });
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const { result, unmount: u } = renderHook(() => useOrder.get('1'));
    unmount = u;
    expect(result.current.order).toEqual({ id: '1', name: 'A' });
    expect(result.current.isLoadingOrder).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it('get static hook delegates to useCollection.useGet with the given id', () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    renderHook(() => useOrder.get('abc'));
    expect(mockUseGet).toHaveBeenCalledWith('abc');
  });

  it('get static hook returns undefined when record not found', () => {
    mockUseGet.mockReturnValue({ record: undefined, isLoading: false, error: undefined });
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const { result, unmount: u } = renderHook(() => useOrder.get('missing'));
    unmount = u;
    expect(result.current.order).toBeUndefined();
  });

  // ─── Static getAll hook ───────────────────────────────────────────────────

  it('getAll static hook returns named records, isLoading, and error', () => {
    mockUseGetAll.mockReturnValue({ records: [{ id: '1' }], isLoading: false, error: undefined });
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const { result, unmount: u } = renderHook(() => useOrder.getAll());
    unmount = u;
    expect(result.current.order).toEqual([{ id: '1' }]);
    expect(result.current.isLoadingOrder).toBe(false);
  });

  it('getAll static hook calls useCollection.useGetAll', () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    renderHook(() => useOrder.getAll());
    expect(mockUseGetAll).toHaveBeenCalled();
  });

  // ─── Static find hook ─────────────────────────────────────────────────────

  it('find static hook returns first matching record', () => {
    mockUseQuery.mockReturnValue({ records: [{ id: '1', status: 'active' }], isLoading: false, total: 1 });
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const { result, unmount: u } = renderHook(() => useOrder.find({ status: 'active' } as any));
    unmount = u;
    expect(result.current.order).toEqual({ id: '1', status: 'active' });
  });

  it('find static hook passes filters to useQuery', () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    renderHook(() => useOrder.find({ status: 'active' } as any));
    expect(mockUseQuery).toHaveBeenCalledWith({ filters: { status: 'active' } });
  });

  it('find static hook returns undefined when no records match', () => {
    mockUseQuery.mockReturnValue({ records: [], isLoading: false, total: 0 });
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const { result, unmount: u } = renderHook(() => useOrder.find({ status: 'gone' } as any));
    unmount = u;
    expect(result.current.order).toBeUndefined();
  });

  // ─── Static query hook ────────────────────────────────────────────────────

  it('query static hook returns named records, isLoading, and total', () => {
    mockUseQuery.mockReturnValue({ records: [{ id: '1' }], isLoading: false, total: 2 });
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const { result, unmount: u } = renderHook(() => useOrder.query());
    unmount = u;
    expect(result.current.order).toEqual([{ id: '1' }]);
    expect(result.current.isLoadingOrder).toBe(false);
    expect(result.current.totalOrder).toBe(2);
  });

  it('query static hook passes QueryProps to useQuery', () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    renderHook(() => useOrder.query({ filters: { status: 'active' } as any }));
    expect(mockUseQuery).toHaveBeenCalledWith({ filters: { status: 'active' } });
  });

  // ─── Static distinct hook ─────────────────────────────────────────────────

  it('distinct static hook returns values, isLoading, and error', () => {
    mockUseDistinct.mockReturnValue({ values: ['pending', 'active'], isLoading: false, error: undefined });
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    const { result, unmount: u } = renderHook(() => useOrder.distinct('status' as any));
    unmount = u;
    expect(result.current.values).toEqual(['pending', 'active']);
    expect(result.current.isLoadingOrder).toBe(false);
  });

  it('distinct static hook delegates to useCollection.useDistinct with the given field', () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: '', name: '' },
    });
    renderHook(() => useOrder.distinct('status' as any));
    expect(mockUseDistinct).toHaveBeenCalledWith('status');
  });
});

describe('createUseRecord (client) — autoSave', () => {
  const collection = { name: 'orders', type: {} as any };
  const mockedUseMXDBRecord = vi.mocked(useMXDBRecord);
  let unmount: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    unmount?.();
    unmount = undefined;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function makeHook() {
    return createUseRecord('order', collection, {
      hydrateRecord: r => r ?? { id: 'id-1', name: '' },
    });
  }

  it('does NOT upsert while the record is still loading (wipe guard)', async () => {
    const upsert = vi.fn();
    mockedUseMXDBRecord.mockReturnValue({ record: undefined, isLoading: true, upsert, remove: vi.fn() } as any);
    const useOrder = makeHook();
    const { result, unmount: u } = renderHook(() => useOrder('id-1', true));
    unmount = u;

    act(() => { result.current.autoSaveOrder({ id: 'id-1', name: 'wiped' }); });
    await act(async () => { vi.advanceTimersByTime(60000); });

    expect(upsert).not.toHaveBeenCalled();
  });

  it('does NOT upsert a queued record on unmount while still loading', async () => {
    const upsert = vi.fn();
    mockedUseMXDBRecord.mockReturnValue({ record: undefined, isLoading: true, upsert, remove: vi.fn() } as any);
    const useOrder = makeHook();
    const { result, unmount: u } = renderHook(() => useOrder('id-1', true));

    act(() => { result.current.autoSaveOrder({ id: 'id-1', name: 'wiped' }); });
    u();
    unmount = undefined;

    expect(upsert).not.toHaveBeenCalled();
  });

  it('upserts once settled, after the default debounce', async () => {
    const upsert = vi.fn();
    mockedUseMXDBRecord.mockReturnValue({ record: { id: 'id-1', name: 'real' }, isLoading: false, upsert, remove: vi.fn() } as any);
    const useOrder = makeHook();
    const { result, unmount: u } = renderHook(() => useOrder('id-1', true));
    unmount = u;

    act(() => { result.current.autoSaveOrder({ id: 'id-1', name: 'edited' }); });
    await act(async () => { vi.advanceTimersByTime(29999); });
    expect(upsert).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(upsert).toHaveBeenCalledWith({ id: 'id-1', name: 'edited' });
  });

  it('withConfig honours a custom debounce', async () => {
    const upsert = vi.fn();
    mockedUseMXDBRecord.mockReturnValue({ record: { id: 'id-1', name: 'real' }, isLoading: false, upsert, remove: vi.fn() } as any);
    const useOrder = makeHook();
    const { result, unmount: u } = renderHook(() => useOrder('id-1', true));
    unmount = u;

    act(() => { result.current.autoSaveOrder.withConfig({ debounceMS: 100 })({ id: 'id-1', name: 'fast' }); });
    await act(async () => { vi.advanceTimersByTime(99); });
    expect(upsert).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(upsert).toHaveBeenCalledWith({ id: 'id-1', name: 'fast' });
  });

  it('explicit upsert throws when persisting the still-loading record (by id)', async () => {
    const upsert = vi.fn();
    mockedUseMXDBRecord.mockReturnValue({ record: undefined, isLoading: true, upsert, remove: vi.fn() } as any);
    const useOrder = makeHook();
    const { result, unmount: u } = renderHook(() => useOrder('id-1', true));
    unmount = u;

    await expect(result.current.upsertOrder({ id: 'id-1', name: 'wiped' })).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('explicit upsert allows a DIFFERENT record while this one is still loading', async () => {
    const upsert = vi.fn();
    mockedUseMXDBRecord.mockReturnValue({ record: undefined, isLoading: true, upsert, remove: vi.fn() } as any);
    const useOrder = makeHook();
    const { result, unmount: u } = renderHook(() => useOrder('id-1', true));
    unmount = u;

    await act(async () => { await result.current.upsertOrder({ id: 'other-id', name: 'fine' }); });

    expect(upsert).toHaveBeenCalledWith({ id: 'other-id', name: 'fine' });
  });

  it('explicit upsert persists once the record has settled', async () => {
    const upsert = vi.fn();
    mockedUseMXDBRecord.mockReturnValue({ record: { id: 'id-1', name: 'real' }, isLoading: false, upsert, remove: vi.fn() } as any);
    const useOrder = makeHook();
    const { result, unmount: u } = renderHook(() => useOrder('id-1', true));
    unmount = u;

    await act(async () => { await result.current.upsertOrder({ id: 'id-1', name: 'edited' }); });

    expect(upsert).toHaveBeenCalledWith({ id: 'id-1', name: 'edited' });
  });

  // Reproduces the LeadWindow "reload wipes contact" bug: the hook id transitions from a
  // settled placeholder to a real record that is still loading. The wipe-guard must re-arm.
  function renderWithId(initialId: string) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const result = { current: undefined as any };
    let root: Root;
    let id = initialId;
    const useOrder = makeHook();
    function Probe() { result.current = useOrder(id, true); return null; }
    act(() => { root = createRoot(container); root.render(<Probe />); });
    return {
      result,
      rerenderWithId(nextId: string) { id = nextId; act(() => { root.render(<Probe />); }); },
      unmount() { act(() => { root.unmount(); }); container.remove(); },
    };
  }

  it('does NOT upsert when the id changes to a still-loading record (re-arms wipe guard)', async () => {
    const upsert = vi.fn();
    // Phase 1: placeholder id settles as a new record (not loading, no stored record).
    mockedUseMXDBRecord.mockReturnValue({ record: undefined, isLoading: false, upsert, remove: vi.fn() } as any);
    const h = renderWithId('placeholder-id');

    // Phase 2: id flips to the real record, which is still loading from the store.
    mockedUseMXDBRecord.mockReturnValue({ record: undefined, isLoading: true, upsert, remove: vi.fn() } as any);
    h.rerenderWithId('real-id');

    // A child field / flush schedules an autosave of the empty placeholder for the real id.
    act(() => { h.result.current.autoSaveOrder({ id: 'real-id', name: '' }); });
    await act(async () => { vi.advanceTimersByTime(60000); });

    expect(upsert).not.toHaveBeenCalled();
    h.unmount();
  });

  it('explicit upsert throws when the id changes to a still-loading record', async () => {
    const upsert = vi.fn();
    mockedUseMXDBRecord.mockReturnValue({ record: undefined, isLoading: false, upsert, remove: vi.fn() } as any);
    const h = renderWithId('placeholder-id');

    mockedUseMXDBRecord.mockReturnValue({ record: undefined, isLoading: true, upsert, remove: vi.fn() } as any);
    h.rerenderWithId('real-id');

    await expect(h.result.current.upsertOrder({ id: 'real-id', name: '' })).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
    h.unmount();
  });

  it('autosaves normally once the newly-targeted record has settled', async () => {
    const upsert = vi.fn();
    mockedUseMXDBRecord.mockReturnValue({ record: undefined, isLoading: false, upsert, remove: vi.fn() } as any);
    const h = renderWithId('placeholder-id');

    mockedUseMXDBRecord.mockReturnValue({ record: undefined, isLoading: true, upsert, remove: vi.fn() } as any);
    h.rerenderWithId('real-id');

    // real-id finishes loading
    mockedUseMXDBRecord.mockReturnValue({ record: { id: 'real-id', name: 'real' }, isLoading: false, upsert, remove: vi.fn() } as any);
    h.rerenderWithId('real-id');

    act(() => { h.result.current.autoSaveOrder({ id: 'real-id', name: 'edited' }); });
    await act(async () => { vi.advanceTimersByTime(30000); });

    expect(upsert).toHaveBeenCalledWith({ id: 'real-id', name: 'edited' });
    h.unmount();
  });
});
