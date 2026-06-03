import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@anupheaus/common'; // install Array.prototype extensions (e.g. .ids())

/**
 * Tests for serverGetAllSubscription.
 *
 * Isolation strategy: mock `createServerCollectionSubscription` to unwrap the raw handler,
 * then call it directly with a fake context to assert the orchestration contract.
 */

const h = vi.hoisted(() => ({
  getAll: vi.fn(),
  onChange: vi.fn(),
  removeOnChange: vi.fn(),
  useCollection: vi.fn(),
  pushSubscriptionResultRecords: vi.fn(),
  getData: vi.fn(),
  s2c: { isNoOp: true } as object,
}));

// Return the handler unwrapped so we can call it directly.
vi.mock('./createServerCollectionSubscription', () => ({
  createServerCollectionSubscription: () => (_sub: unknown, handler: unknown) => handler,
}));

vi.mock('../collections', () => ({
  useCollection: h.useCollection,
}));

vi.mock('../providers', () => ({
  useServerToClientSynchronisation: () => h.s2c,
}));

vi.mock('../hooks', () => ({
  useClient: () => ({ getData: h.getData }),
}));

vi.mock('./pushSubscriptionResultRecords', () => ({
  pushSubscriptionResultRecords: h.pushSubscriptionResultRecords,
}));

// Imported AFTER the mocks above so it resolves to the unwrapped handler.
import { serverGetAllSubscription } from './getAllSubscription';

function makeRecords(ids: string[]) {
  const arr = ids.map(id => ({ id })) as any[];
  (arr as any).ids = () => ids;
  return arr;
}

function makeContext(overrides?: object) {
  const unsubHandlers: (() => void)[] = [];
  return {
    subscriptionId: 'sub-1',
    request: { collectionName: 'items' },
    previousResponse: undefined as string[] | undefined,
    additionalData: undefined as string[] | undefined,
    updateAdditionalData: vi.fn(),
    update: vi.fn(),
    onUnsubscribe: (fn: () => void) => { unsubHandlers.push(fn); },
    _triggerUnsubscribe: () => unsubHandlers.forEach(fn => fn()),
    ...overrides,
  };
}

const collectionToken = { name: 'items' } as object;

beforeEach(() => {
  vi.clearAllMocks();
  h.getAll.mockResolvedValue(makeRecords(['r1', 'r2']));
  h.useCollection.mockReturnValue({
    collection: collectionToken,
    getAll: h.getAll,
    onChange: h.onChange,
    removeOnChange: h.removeOnChange,
  });
  h.pushSubscriptionResultRecords.mockResolvedValue(undefined);
  h.getData.mockReturnValue(undefined);
});

describe('getAllSubscription', () => {
  it('calls getAll on initial subscription', async () => {
    const ctx = makeContext();
    await (serverGetAllSubscription as any)(ctx);
    expect(h.getAll).toHaveBeenCalledTimes(1);
  });

  it('pushes initial records via pushSubscriptionResultRecords', async () => {
    const records = makeRecords(['r1', 'r2']);
    h.getAll.mockResolvedValue(records);
    const ctx = makeContext();
    await (serverGetAllSubscription as any)(ctx);
    expect(h.pushSubscriptionResultRecords).toHaveBeenCalledTimes(1);
    // removedIds should be [] since getData returns undefined (no prior ids)
    expect(h.pushSubscriptionResultRecords).toHaveBeenCalledWith(h.s2c, collectionToken, records, []);
  });

  it('returns initial record ids array', async () => {
    const ctx = makeContext();
    const result = await (serverGetAllSubscription as any)(ctx);
    expect(result).toEqual(['r1', 'r2']);
  });

  it('calls update when record list changes', async () => {
    const ctx = makeContext();
    await (serverGetAllSubscription as any)(ctx);

    // Capture onChange callback
    const onChangeCb: () => Promise<void> = h.onChange.mock.calls[0]![1];

    // Simulate that additional data was stored as ['r1', 'r2']
    h.getData.mockReturnValue(['r1', 'r2']);

    // Change what getAll returns
    h.getAll.mockResolvedValue(makeRecords(['r1', 'r2', 'r3']));

    await onChangeCb();

    expect(ctx.update).toHaveBeenCalledTimes(1);
    expect(ctx.update).toHaveBeenCalledWith(['r1', 'r2', 'r3']);
  });

  it('does NOT call update when record list is unchanged', async () => {
    const ctx = makeContext();
    await (serverGetAllSubscription as any)(ctx);

    // Capture onChange callback
    const onChangeCb: () => Promise<void> = h.onChange.mock.calls[0]![1];

    // Simulate stored additional data matching current getAll result
    h.getData.mockReturnValue(['r1', 'r2']);

    // getAll still returns the same records
    h.getAll.mockResolvedValue(makeRecords(['r1', 'r2']));

    await onChangeCb();

    expect(ctx.update).not.toHaveBeenCalled();
  });

  it('pushes removedIds for records no longer in collection', async () => {
    // Initial: r1, r2 were stored as prior ids
    h.getData.mockReturnValue(['r1', 'r2']);
    // Now getAll returns only r1
    h.getAll.mockResolvedValue(makeRecords(['r1']));

    const ctx = makeContext();
    await (serverGetAllSubscription as any)(ctx);

    expect(h.pushSubscriptionResultRecords).toHaveBeenCalledWith(
      h.s2c,
      collectionToken,
      expect.anything(),
      ['r2'],
    );
  });

  it('removes onChange listener on unsubscribe', async () => {
    const ctx = makeContext();
    await (serverGetAllSubscription as any)(ctx);
    ctx._triggerUnsubscribe();
    expect(h.removeOnChange).toHaveBeenCalledTimes(1);
    expect(h.removeOnChange).toHaveBeenCalledWith('mxdb.getAll.sub-1');
  });
});
