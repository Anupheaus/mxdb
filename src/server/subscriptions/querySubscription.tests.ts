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
  useLogger: () => ({ error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(), silly: vi.fn() }),
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
    const onQuery = vi.fn<Parameters<OnQueryHook>, ReturnType<OnQueryHook>>(() => undefined);
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
    const onQuery = vi.fn<Parameters<OnQueryHook>, ReturnType<OnQueryHook>>(() => undefined);
    registerOnQuery(onQuery);

    await runSubscription({ serverHints: { scope: 'mine' } });

    expect(onQuery.mock.calls[0]![0].userId).toBe('user-42');
  });

  it('passes undefined userId to onQuery when there is no auth context', async () => {
    h.auth.throws = true;
    const onQuery = vi.fn<Parameters<OnQueryHook>, ReturnType<OnQueryHook>>(() => undefined);
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
