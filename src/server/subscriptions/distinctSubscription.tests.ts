import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@anupheaus/common'; // install Array.prototype extensions (e.g. .ids(), String.hash())

/**
 * Tests for serverDistinctSubscription.
 *
 * Isolation strategy: mock `createServerCollectionSubscription` to unwrap the raw handler,
 * then call it directly with a fake context to assert the orchestration contract.
 */

const h = vi.hoisted(() => ({
  distinct: vi.fn(),
  onChange: vi.fn(),
  removeOnChange: vi.fn(),
  useCollection: vi.fn(),
  pushSubscriptionResultRecords: vi.fn(),
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

vi.mock('./pushSubscriptionResultRecords', () => ({
  pushSubscriptionResultRecords: h.pushSubscriptionResultRecords,
}));

// Imported AFTER the mocks above so it resolves to the unwrapped handler.
import { serverDistinctSubscription } from './distinctSubscription';

function makeRecords(ids: string[]) {
  const arr = ids.map(id => ({ id })) as any[];
  (arr as any).ids = () => ids;
  return arr;
}

function makeContext(overrides?: object) {
  const unsubHandlers: (() => void)[] = [];
  return {
    subscriptionId: 'sub-1',
    request: { collectionName: 'items', field: 'name' },
    previousResponse: undefined as string | undefined,
    additionalData: undefined,
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
  h.distinct.mockResolvedValue(makeRecords(['r1', 'r2']));
  h.useCollection.mockReturnValue({
    collection: collectionToken,
    distinct: h.distinct,
    onChange: h.onChange,
    removeOnChange: h.removeOnChange,
  });
  h.pushSubscriptionResultRecords.mockResolvedValue(undefined);
});

describe('distinctSubscription', () => {
  it('calls distinct with request on initial subscription', async () => {
    const ctx = makeContext();
    await (serverDistinctSubscription as any)(ctx);
    expect(h.distinct).toHaveBeenCalledTimes(1);
    expect(h.distinct).toHaveBeenCalledWith({ field: 'name' });
  });

  it('pushes initial records via pushSubscriptionResultRecords', async () => {
    const records = makeRecords(['r1', 'r2']);
    h.distinct.mockResolvedValue(records);
    const ctx = makeContext();
    await (serverDistinctSubscription as any)(ctx);
    expect(h.pushSubscriptionResultRecords).toHaveBeenCalledTimes(1);
    expect(h.pushSubscriptionResultRecords).toHaveBeenCalledWith(h.s2c, collectionToken, records, []);
  });

  it('returns a hash string of initial record ids', async () => {
    const ctx = makeContext();
    const result = await (serverDistinctSubscription as any)(ctx);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('registers onChange listener', async () => {
    const ctx = makeContext();
    await (serverDistinctSubscription as any)(ctx);
    expect(h.onChange).toHaveBeenCalledTimes(1);
    expect(h.onChange).toHaveBeenCalledWith('mxdb.distinct.sub-1', expect.any(Function));
  });

  it('calls update when records change', async () => {
    const ctx = makeContext();
    // Run initial subscription
    const initialHash = await (serverDistinctSubscription as any)(ctx);

    // Capture onChange callback
    const onChangeCb: () => Promise<void> = h.onChange.mock.calls[0]![1];

    // Change what distinct returns
    const newRecords = makeRecords(['r1', 'r2', 'r3']);
    h.distinct.mockResolvedValue(newRecords);

    // Update previousResponse to the initial hash so we can detect change
    ctx.previousResponse = initialHash;

    // Fire onChange
    await onChangeCb();

    expect(ctx.update).toHaveBeenCalledTimes(1);
  });

  it('does NOT call update when hash is unchanged', async () => {
    // Pre-compute what the hash will be so we can pass it as previousResponse.
    // The subscription captures `previousResponse` from the destructured parameter
    // at call time, so we must supply it upfront.
    const expectedHash = ['r1', 'r2'].join('|').hash();
    const ctx = makeContext({ previousResponse: expectedHash });
    await (serverDistinctSubscription as any)(ctx);

    // Capture onChange callback
    const onChangeCb: () => Promise<void> = h.onChange.mock.calls[0]![1];

    // distinct still returns the same records (r1, r2) — hash unchanged
    await onChangeCb();

    expect(ctx.update).not.toHaveBeenCalled();
  });

  it('removes onChange listener on unsubscribe', async () => {
    const ctx = makeContext();
    await (serverDistinctSubscription as any)(ctx);
    ctx._triggerUnsubscribe();
    expect(h.removeOnChange).toHaveBeenCalledTimes(1);
    expect(h.removeOnChange).toHaveBeenCalledWith('mxdb.distinct.sub-1');
  });
});
