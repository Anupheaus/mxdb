import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@anupheaus/common'; // install Array.prototype extensions (e.g. .ids())
import type { QueryProps } from '../../common';

/**
 * Tests for how `serverHints` is handled by the query subscription.
 *
 * The behavioural contract:
 *  - `serverHints` from the request is delivered to the collection's `onQuery`
 *    extension hook (it is the *interpreter* of hints).
 *  - When `onQuery` returns a modified request, that modified request drives the
 *    actual DB query.
 *  - `serverHints` is server-only metadata and is NEVER forwarded into the executed
 *    DB `query()` call — it is consumed by the hook, not applied to storage.
 *
 * We isolate the subscription handler from the Nexus subscription framework by
 * mocking `createServerCollectionSubscription` so it returns the raw handler,
 * letting us invoke it directly with a fake context and assert the orchestration.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  onChange: vi.fn(),
  removeOnChange: vi.fn(),
  useCollection: vi.fn(),
  getCollectionExtensions: vi.fn(),
  pushSubscriptionResultRecords: vi.fn(),
  collectionToken: { name: 'items', type: null as unknown },
  auth: { user: { id: 'u1' } as { id: string } | undefined, throws: false },
  logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(), silly: vi.fn() },
}));

// Return the handler unwrapped so we can call it directly.
vi.mock('./createServerCollectionSubscription', () => ({
  createServerCollectionSubscription: () => (_sub: unknown, handler: unknown) => handler,
}));

vi.mock('../collections', () => ({
  useCollection: h.useCollection,
  getCollectionExtensions: h.getCollectionExtensions,
}));

vi.mock('../providers', () => ({
  useDb: () => ({ use: () => ({ collection: h.collectionToken }) }),
  useServerToClientSynchronisation: () => ({ isNoOp: true }),
}));

vi.mock('./pushSubscriptionResultRecords', () => ({
  pushSubscriptionResultRecords: h.pushSubscriptionResultRecords,
}));

vi.mock('@anupheaus/nexus/server', () => ({
  useLogger: () => h.logger,
  useAuthentication: () => {
    if (h.auth.throws) throw new Error('no auth context');
    return { user: h.auth.user };
  },
}));

// Imported AFTER the mocks above so it resolves to the unwrapped handler.
import { serverQuerySubscription } from './querySubscription';

type OnQueryHook = (payload: { request: QueryProps<{ id: string }>; userId: string | undefined }) =>
  QueryProps<{ id: string }> | void | Promise<QueryProps<{ id: string }> | void>;

interface RequestShape {
  collectionName?: string;
  filters?: Record<string, unknown>;
  sorts?: Record<string, unknown>;
  pagination?: Record<string, unknown>;
  getAccurateTotal?: boolean;
  serverHints?: Record<string, unknown>;
}

/** Invoke the subscription handler with a minimal fake context; returns the executed query's request arg. */
async function runSubscription(request: RequestShape): Promise<RequestShape> {
  await (serverQuerySubscription as unknown as (p: unknown) => Promise<number>)({
    request: { collectionName: 'items', ...request },
    previousResponse: undefined,
    subscriptionId: 'sub-1',
    additionalData: undefined,
    updateAdditionalData: vi.fn(),
    update: vi.fn(),
    onUnsubscribe: vi.fn(),
  });
  expect(h.query).toHaveBeenCalledTimes(1);
  return h.query.mock.calls[0]![0] as RequestShape;
}

function registerOnQuery(onQuery: OnQueryHook): void {
  h.getCollectionExtensions.mockReturnValue({ onQuery });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.user = { id: 'u1' };
  h.auth.throws = false;
  h.query.mockResolvedValue({ data: [{ id: 'a' }, { id: 'b' }], total: 2 });
  h.useCollection.mockReturnValue({
    collection: h.collectionToken,
    query: h.query,
    onChange: h.onChange,
    removeOnChange: h.removeOnChange,
  });
  h.getCollectionExtensions.mockReturnValue(undefined); // no extensions by default
  h.pushSubscriptionResultRecords.mockResolvedValue(undefined);
});

describe('querySubscription — serverHints handling', () => {
  it('delivers serverHints to the onQuery hook in the request', async () => {
    const onQuery = vi.fn<OnQueryHook>(() => undefined);
    registerOnQuery(onQuery);

    await runSubscription({ filters: { active: true }, serverHints: { latestPerSchedule: true } });

    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onQuery.mock.calls[0]![0].request.serverHints).toEqual({ latestPerSchedule: true });
    expect(onQuery.mock.calls[0]![0].request.filters).toEqual({ active: true });
  });

  it('does NOT forward serverHints into the executed DB query (server-only metadata)', async () => {
    registerOnQuery(() => undefined);

    const queryArg = await runSubscription({ filters: { active: true }, serverHints: { scope: 'mine' } });

    expect(queryArg).not.toHaveProperty('serverHints');
    expect(queryArg.filters).toEqual({ active: true });
  });

  it('does not forward serverHints even when no onQuery hook is registered', async () => {
    // getCollectionExtensions returns undefined (default) — hook absent.
    const queryArg = await runSubscription({ filters: { active: true }, serverHints: { scope: 'all' } });

    expect(queryArg).not.toHaveProperty('serverHints');
    expect(queryArg.filters).toEqual({ active: true });
  });

  it('applies the onQuery-modified request to the executed query', async () => {
    // Hook interprets the hint and returns a request with extra server-side scoping.
    registerOnQuery(({ request }) =>
      request.serverHints?.scope === 'mine'
        ? { filters: { tenantId: 't1' }, sorts: { name: 'asc' } } as unknown as QueryProps<{ id: string }>
        : undefined);

    const queryArg = await runSubscription({ filters: { active: true }, serverHints: { scope: 'mine' } });

    expect(queryArg.filters).toEqual({ tenantId: 't1' });
    expect(queryArg.sorts).toEqual({ name: 'asc' });
    expect(queryArg).not.toHaveProperty('serverHints'); // still stripped after rewrite
  });

  it('uses the original request when onQuery returns void', async () => {
    registerOnQuery(() => undefined);

    const queryArg = await runSubscription({ filters: { active: true }, serverHints: { scope: 'mine' } });

    expect(queryArg.filters).toEqual({ active: true });
  });

  it('passes the authenticated userId to the onQuery hook', async () => {
    h.auth.user = { id: 'user-42' };
    const onQuery = vi.fn<OnQueryHook>(() => undefined);
    registerOnQuery(onQuery);

    await runSubscription({ serverHints: { scope: 'mine' } });

    expect(onQuery.mock.calls[0]![0].userId).toBe('user-42');
  });

  it('passes undefined userId to onQuery when there is no auth context', async () => {
    h.auth.throws = true;
    const onQuery = vi.fn<OnQueryHook>(() => undefined);
    registerOnQuery(onQuery);

    await runSubscription({ serverHints: { scope: 'mine' } });

    expect(onQuery.mock.calls[0]![0].userId).toBeUndefined();
  });

  it('runs a hints-only query (no filters) and still omits serverHints from the executed query', async () => {
    registerOnQuery(() => undefined);

    const queryArg = await runSubscription({ serverHints: { latestPerSchedule: true } });

    expect(queryArg).not.toHaveProperty('serverHints');
    expect(queryArg.filters).toBeUndefined();
  });
});

// ─── Live updates, unsubscribe and failures ───────────────────────────────────

interface QueryResult { data: { id: string }[]; total: number }

function queryResult(ids: string[], total = ids.length): QueryResult {
  return { data: ids.map(id => ({ id })), total };
}

interface LiveSubscription {
  /** Resolves to the subscription's initial response (the total). */
  response: Promise<number>;
  update: ReturnType<typeof vi.fn>;
  updateAdditionalData: ReturnType<typeof vi.fn>;
  /** Fire the collection change callback registered by the subscription and wait for it to finish. */
  fireChange(): Promise<void>;
  /** Simulate the client unsubscribing. */
  unsubscribe(): void;
}

interface SubscribeOptions {
  request?: RequestShape;
  /** Response remembered from an earlier subscribe with the same id (re-subscribe). */
  previousResponse?: number;
  /** Record ids remembered from an earlier subscribe with the same id (re-subscribe). */
  previousRecordIds?: string[];
}

function subscribe({ request = {}, previousResponse, previousRecordIds }: SubscribeOptions = {}): LiveSubscription {
  const update = vi.fn();
  const updateAdditionalData = vi.fn();
  const unsubscribeHandlers: Array<() => void> = [];
  const response = (serverQuerySubscription as unknown as (p: unknown) => Promise<number>)({
    request: { collectionName: 'items', ...request },
    previousResponse,
    subscriptionId: 'sub-1',
    additionalData: previousRecordIds,
    updateAdditionalData,
    update,
    onUnsubscribe: (handler: () => void) => { unsubscribeHandlers.push(handler); },
  });
  return {
    response,
    update,
    updateAdditionalData,
    fireChange: async () => {
      const [, changeCallback] = h.onChange.mock.calls.at(-1)! as [string, () => Promise<void>];
      await changeCallback();
    },
    unsubscribe: () => { for (const handler of unsubscribeHandlers) handler(); },
  };
}

describe('querySubscription — initial response', () => {
  it('responds with the query total', async () => {
    h.query.mockResolvedValue(queryResult(['a', 'b'], 17));

    await expect(subscribe().response).resolves.toBe(17);
  });

  it('remembers the ids of the matching records for later change comparisons', async () => {
    h.query.mockResolvedValue(queryResult(['b', 'a']));
    const subscription = subscribe();

    await subscription.response;

    expect(subscription.updateAdditionalData).toHaveBeenCalledWith(['b', 'a']);
  });

  it('pushes the matching records to the client', async () => {
    const result = queryResult(['a', 'b']);
    h.query.mockResolvedValue(result);

    await subscribe().response;

    expect(h.pushSubscriptionResultRecords).toHaveBeenCalledWith(expect.anything(), h.collectionToken, result.data, []);
  });

  const accurateTotalCases: Array<[boolean | undefined, boolean]> = [
    [undefined, true],
    [true, true],
    [false, false],
  ];

  it.each(accurateTotalCases)('asks the query for an accurate total when getAccurateTotal is %s → %s', async (requested, expected) => {
    await subscribe({ request: { getAccurateTotal: requested } }).response;

    expect(h.query.mock.calls[0]![0].getAccurateTotal).toBe(expected);
  });

  it('rejects when the initial query fails', async () => {
    h.query.mockRejectedValue(new Error('mongo down'));

    await expect(subscribe().response).rejects.toThrow('mongo down');
  });

  it('logs the initial query failure', async () => {
    h.query.mockRejectedValue(new Error('mongo down'));

    await subscribe().response.catch(() => undefined);

    expect(h.logger.error).toHaveBeenCalledWith('querySubscription setup error (initial push failed)',
      expect.objectContaining({ collectionName: 'items', subscriptionId: 'sub-1', error: 'mongo down' }));
  });

  it('rejects when pushing the initial records to the client fails', async () => {
    h.pushSubscriptionResultRecords.mockRejectedValue(new Error('emit failed'));

    await expect(subscribe().response).rejects.toThrow('emit failed');
  });
});

describe('querySubscription — collection changes', () => {
  it('re-runs the query and pushes the fresh records when the collection changes', async () => {
    const subscription = subscribe();
    await subscription.response;
    const fresh = queryResult(['a', 'b', 'c']);
    h.query.mockResolvedValue(fresh);

    await subscription.fireChange();

    expect(h.pushSubscriptionResultRecords).toHaveBeenLastCalledWith(expect.anything(), h.collectionToken, fresh.data, []);
  });

  it('pushes change results through the S2C captured when the subscription was set up', async () => {
    const subscription = subscribe();
    await subscription.response;
    const setupS2C = h.pushSubscriptionResultRecords.mock.calls[0]![0];

    await subscription.fireChange();

    expect(h.pushSubscriptionResultRecords.mock.calls[1]![0]).toBe(setupS2C);
  });

  // Re-subscribe scenario: the subscription remembers total 2 with ids [a, b].
  const changeOutcomes: Array<[string, QueryResult, number | undefined]> = [
    ['the total changes', queryResult(['a', 'b'], 5), 5],
    ['a record is added', queryResult(['a', 'b', 'c'], 2), 2],
    ['the order changes', queryResult(['b', 'a'], 2), 2],
    ['a record is replaced by another', queryResult(['a', 'z'], 2), 2],
    ['nothing visible changes', queryResult(['a', 'b'], 2), undefined],
  ];

  it.each(changeOutcomes)('when %s, sends the client update %s', async (_label, result, expectedUpdate) => {
    h.query.mockResolvedValue(queryResult(['a', 'b'], 2));
    const subscription = subscribe({ previousResponse: 2, previousRecordIds: ['a', 'b'] });
    await subscription.response;
    h.query.mockResolvedValue(result);

    await subscription.fireChange();

    expect(subscription.update.mock.calls).toEqual(expectedUpdate == null ? [] : [[expectedUpdate]]);
  });

  it('does not throw from the change callback when the re-query fails', async () => {
    const subscription = subscribe();
    await subscription.response;
    h.query.mockRejectedValue(new Error('mongo blip'));

    await expect(subscription.fireChange()).resolves.toBeUndefined();
  });

  it('sends no update and logs when the re-query fails', async () => {
    const subscription = subscribe();
    await subscription.response;
    h.query.mockRejectedValue(new Error('mongo blip'));

    await subscription.fireChange();

    expect(subscription.update).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith('querySubscription onChange error',
      expect.objectContaining({ collectionName: 'items', subscriptionId: 'sub-1', error: 'mongo blip' }));
  });

  it('stops watching the collection when the client unsubscribes', async () => {
    const subscription = subscribe();
    await subscription.response;
    const [watchId] = h.onChange.mock.calls[0]! as [string];

    subscription.unsubscribe();

    expect(h.removeOnChange).toHaveBeenCalledWith(watchId);
  });

  it('watches under an id unique to the subscription', async () => {
    await subscribe().response;

    expect(h.onChange.mock.calls[0]![0]).toBe('mxdb.query.sub-1');
  });
});
