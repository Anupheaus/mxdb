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
    const callArg = (ctx.update as any).mock.calls[0]![0];
    expect(typeof callArg).toBe('string');
    expect(callArg.length).toBeGreaterThan(0);
    expect(callArg).not.toBe(initialHash);
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

// ─── Change comparison baseline ────────────────────────────────────────────────

/** The response the subscription sends for a given ordered set of distinct record ids. */
function hashOf(ids: string[]): string {
  return ids.join('|').hash();
}

/** Subscribe with `options`, then apply each change in turn; returns the updates the client was sent. */
async function updatesForChanges(options: object, changes: string[][]): Promise<unknown[][]> {
  const ctx = makeContext(options);
  await (serverDistinctSubscription as unknown as (context: typeof ctx) => Promise<unknown>)(ctx);
  const [, onChangeCb] = h.onChange.mock.calls[0]! as [string, () => Promise<void>];
  for (const ids of changes) {
    h.distinct.mockResolvedValue(makeRecords(ids));
    await onChangeCb();
  }
  return ctx.update.mock.calls;
}

describe('distinctSubscription — change comparison baseline', () => {
  // Initial distinct result is ['r1', 'r2'] (see beforeEach).
  const scenarios: Array<[string, object, string[][], string[][]]> = [
    ['first-time subscription with no visible change sends nothing', {}, [['r1', 'r2']], []],
    ['re-subscribe with stale remembered values compares against the fresh initial response', { previousResponse: hashOf(['stale']) }, [['r1', 'r2']], []],
    ['first-time: a change then a change back sends both', {}, [['r1', 'r2', 'r3'], ['r1', 'r2']], [['r1', 'r2', 'r3'], ['r1', 'r2']]],
    ['re-subscribe: a change then a change back sends both', { previousResponse: hashOf(['r1', 'r2']) }, [['r1', 'r2', 'r3'], ['r1', 'r2']], [['r1', 'r2', 'r3'], ['r1', 'r2']]],
    ['a repeated no-op after an update sends nothing more', {}, [['r1', 'r2', 'r3'], ['r1', 'r2', 'r3']], [['r1', 'r2', 'r3']]],
  ];

  it.each(scenarios)('%s', async (_label, options, changes, expectedUpdateIds) => {
    const updates = await updatesForChanges(options, changes);

    expect(updates).toEqual(expectedUpdateIds.map(ids => [hashOf(ids)]));
  });
});
