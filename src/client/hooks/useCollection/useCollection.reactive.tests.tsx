/**
 * Reactivity tests for useCollection-style hooks (getAll / query / distinct / get).
 *
 * **Simulating “server sent a sync” (easy pattern):** production code applies server
 * payloads into the local `DbCollection` (SQLite + in-memory cache), then emits the
 * same `onChange` events as a local upsert/remove. These tests skip the wire and
 * call `applyServerUpsert` / `applyServerRemove` on a mock collection: anything that
 * subscribed via `useSubscriptionWrapper`’s `collection.onChange` listener will
 * re-run the local `getAll` / `query` / `distinct` / `get` path, so hook state and
 * callback-style APIs stay in sync with the mock “local DB”.
 *
 * For full stack coverage (real socket + Mongo), use `tests/sync-test/` instead.
 */
// @vitest-environment jsdom

import '@anupheaus/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Record } from '@anupheaus/common';
import type { DataRequest } from '@anupheaus/common';
import type { DbCollection } from '../../providers/dbs/DbCollection';
import type { MXDBCollectionEvent } from '../../providers/dbs/models';
import type { DistinctProps, DistinctResults, QueryResults } from '../../../common/models';
import { createUseSubscription } from './createUseSubscription';
import { LoggerProvider, useLogger } from '@anupheaus/react-ui';
import { createGetAll } from './createGetAll';
import { createQuery } from './createQuery';
import { createDistinct } from './createDistinct';
import { createGet } from './createGet';
import { createUseGetAll } from './createUseGetAll';
import { createUseQuery } from './createUseQuery';
import { createUseDistinct } from './createUseDistinct';
import { createUseGet } from './createUseGet';

vi.mock('@anupheaus/nexus/client', () => ({
  useNexus: () => ({ getIsConnected: () => true }),
  useSubscription: () => {
    // Simulate server acknowledging the subscription by calling the registered
    // onCallback handler after subscribe resolves. This mimics real socket-api
    // behaviour where the server sends the current state when a client subscribes,
    // which triggers executeValidateAndUpdate() and loads local data into state.
    let storedCallback: ((response: unknown) => void) | undefined;
    return {
      subscribe: vi.fn().mockImplementation(async () => {
        // Fire on the next microtask so it runs after execute() has returned true
        // and remoteQueryCalledRef has been set, matching production timing.
        await Promise.resolve();
        storedCallback?.([]);
      }),
      unsubscribe: vi.fn(),
      onCallback: vi.fn().mockImplementation((cb: (response: unknown) => void) => {
        storedCallback = cb;
      }),
    };
  },
  useAction: () =>
    new Proxy(
      { isConnected: () => false },
      {
        get(_target, prop: string) {
          if (prop === 'isConnected') return () => false;
          return vi.fn(async () => ({}));
        },
      },
    ),
}));

interface Widget extends Record {
  id: string;
  name: string;
  city: string;
}

/** Minimal in-memory stand-in for {@link DbCollection} change / read behaviour. */
class MockLocalCollection {
  readonly name = 'widgets';

  readonly #records = new Map<string, Widget>();
  readonly #listeners = new Set<(event: MXDBCollectionEvent<Widget>) => void>();

  async getAll(): Promise<Widget[]> {
    return [...this.#records.values()];
  }

  async get(id: string): Promise<Widget | undefined>;
  async get(ids: string[]): Promise<Widget[]>;
  async get(idOrIds: string | string[]): Promise<Widget | Widget[] | undefined> {
    if (Array.isArray(idOrIds)) {
      return idOrIds.map(id => this.#records.get(id)).filter((r): r is Widget => r != null);
    }
    return this.#records.get(idOrIds);
  }

  async query(_request: DataRequest<Widget>): Promise<QueryResults<Widget>> {
    const records = [...this.#records.values()];
    return { records, total: records.length };
  }

  async distinct<Key extends keyof Widget>({ field }: DistinctProps<Widget, Key>): Promise<DistinctResults<Widget, Key>> {
    const values = new Set<Widget[Key]>();
    for (const r of this.#records.values()) {
      values.add(r[field]);
    }
    return [...values] as DistinctResults<Widget, Key>;
  }

  onChange(callback: (event: MXDBCollectionEvent<Widget>) => void): () => void {
    this.#listeners.add(callback);
    return () => this.#listeners.delete(callback);
  }

  applyServerUpsert(record: Widget): void {
    this.#records.set(record.id, record);
    this.#emit({ type: 'upsert', records: [record], auditAction: 'default' });
  }

  applyServerRemove(id: string): void {
    this.#records.delete(id);
    this.#emit({ type: 'remove', ids: [id], auditAction: 'markAsDeleted' });
  }

  seed(records: Widget[]): void {
    this.#records.clear();
    for (const r of records) this.#records.set(r.id, r);
  }

  #emit(event: MXDBCollectionEvent<Widget>): void {
    for (const cb of this.#listeners) cb(event);
  }
}

function asDbCollection(c: MockLocalCollection): DbCollection<Widget> {
  return c as unknown as DbCollection<Widget>;
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Comfortably past the ~50ms onChange debounce in useSubscriptionWrapper, yet well under the 5s action timeout —
 *  so a change-driven re-query fires but the withTimeout guard never trips. */
const PAST_CHANGE_DEBOUNCE_MS = 200;

/** Advance past the onChange debounce (and flush the microtasks its re-query schedules) so change-driven updates land. */
async function flushChange(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PAST_CHANGE_DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function AllHooksProbe({ collection, targetId }: { collection: MockLocalCollection; targetId: string }) {
  const useSubscription = createUseSubscription();
  const logger = useLogger(collection.name);
  const db = asDbCollection(collection);

  const getAll = createGetAll(db, useSubscription, logger);
  const query = createQuery(db, useSubscription, logger);
  const distinct = createDistinct(db, useSubscription, logger);
  const get = createGet(db);

  const useGetAll = createUseGetAll(getAll);
  const useQuery = createUseQuery(query, logger);
  const useDistinct = createUseDistinct(distinct);
  const useGet = createUseGet(db, get);

  const ga = useGetAll();
  const uq = useQuery({});
  const ud = useDistinct('city');
  const ug = useGet(targetId);

  return (
    <div>
      <span data-testid="ga-count">{ga.records.length}</span>
      <span data-testid="ga-loading">{String(ga.isLoading)}</span>
      <span data-testid="uq-len">{uq.records.length}</span>
      <span data-testid="ud-len">{ud.values.length}</span>
      <span data-testid="ug-name">{ug.record?.name ?? ''}</span>
    </div>
  );
}

function GetAllCallbackProbe({ collection }: { collection: MockLocalCollection }) {
  const useSubscription = createUseSubscription();
  const logger = useLogger(collection.name);
  const getAll = createGetAll(asDbCollection(collection), useSubscription, logger);
  const [len, setLen] = useState(-1);
  const props = {};
  useLayoutEffect(() => {
    void getAll(props, records => setLen(records.length));
  }, [Object.hash(props)]);
  return <span data-testid="cb-getAll-len">{len}</span>;
}

function QueryCallbackProbe({ collection }: { collection: MockLocalCollection }) {
  const useSubscription = createUseSubscription();
  const logger = useLogger(collection.name);
  const query = createQuery(asDbCollection(collection), useSubscription, logger);
  const [len, setLen] = useState(-1);
  const props = {};
  useLayoutEffect(() => {
    void query(props, ({ records }) => setLen(records.length));
  }, [Object.hash(props)]);
  return <span data-testid="cb-query-len">{len}</span>;
}

function DistinctCallbackProbe({ collection }: { collection: MockLocalCollection }) {
  const useSubscription = createUseSubscription();
  const logger = useLogger(collection.name);
  const distinct = createDistinct(asDbCollection(collection), useSubscription, logger);
  const [len, setLen] = useState(-1);
  useLayoutEffect(() => {
    void distinct('city', values => setLen(values.length));
  }, []);
  return <span data-testid="cb-distinct-len">{len}</span>;
}

function SingleQueryProbe({ collection }: { collection: MockLocalCollection }) {
  const useSubscription = createUseSubscription();
  const logger = useLogger(collection.name);
  const query = createQuery(asDbCollection(collection), useSubscription, logger);
  const useQuery = createUseQuery(query, logger);
  const { records } = useQuery({});
  return <span data-testid="single-len">{records.length}</span>;
}

/** Two independent useQuery subscribers on the same collection — used to prove each debounces its own onChange
 *  callback separately, so a shared burst still re-runs both. */
function TwoQueryProbe({ collection }: { collection: MockLocalCollection }) {
  const useSubscription = createUseSubscription();
  const logger = useLogger(collection.name);
  const db = asDbCollection(collection);
  const useQueryA = createUseQuery(createQuery(db, useSubscription, logger), logger);
  const useQueryB = createUseQuery(createQuery(db, useSubscription, logger), logger);
  const a = useQueryA({});
  const b = useQueryB({});
  return (
    <div>
      <span data-testid="two-a">{a.records.length}</span>
      <span data-testid="two-b">{b.records.length}</span>
    </div>
  );
}

describe('useCollection hooks react to local collection changes (sync simulation)', () => {
  let root: Root | undefined;
  let container: HTMLDivElement;

  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  beforeEach(() => {
    // Fake timers let us drive the onChange debounce deterministically instead of waiting real time.
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    vi.useRealTimers();
  });

  it('useGetAll, useQuery, useDistinct, and useGet update after upsert and remove', async () => {
    const collection = new MockLocalCollection();
    collection.seed([
      { id: 'a', name: 'Alpha', city: 'London' },
      { id: 'b', name: 'Beta', city: 'Paris' },
    ]);

    container = document.createElement('div');
    root = createRoot(container);
    act(() =>
      root!.render(
        <LoggerProvider logger={undefined} loggerName="useCollection-reactive">
          <AllHooksProbe collection={collection} targetId="a" />
        </LoggerProvider>,
      ),
    );

    await flushMicrotasks();
    expect(container.querySelector('[data-testid="ga-loading"]')?.textContent).toBe('false');
    expect(container.querySelector('[data-testid="ga-count"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-testid="uq-len"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-testid="ud-len"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-testid="ug-name"]')?.textContent).toBe('Alpha');

    await act(async () => {
      collection.applyServerUpsert({ id: 'c', name: 'Gamma', city: 'London' });
    });
    await flushChange();

    expect(container.querySelector('[data-testid="ga-count"]')?.textContent).toBe('3');
    expect(container.querySelector('[data-testid="uq-len"]')?.textContent).toBe('3');
    expect(container.querySelector('[data-testid="ud-len"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-testid="ug-name"]')?.textContent).toBe('Alpha');

    await act(async () => {
      collection.applyServerUpsert({ id: 'a', name: 'Alpha-up', city: 'London' });
    });
    await flushChange();
    expect(container.querySelector('[data-testid="ug-name"]')?.textContent).toBe('Alpha-up');

    await act(async () => {
      collection.applyServerRemove('b');
    });
    await flushChange();
    expect(container.querySelector('[data-testid="ga-count"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-testid="uq-len"]')?.textContent).toBe('2');
  });

  it('callback-style getAll, query, and distinct refresh when the collection changes', async () => {
    const collection = new MockLocalCollection();
    collection.seed([{ id: '1', name: 'One', city: 'X' }]);

    container = document.createElement('div');
    root = createRoot(container);
    act(() =>
      root!.render(
        <LoggerProvider logger={undefined} loggerName="useCollection-callback">
          <div>
            <GetAllCallbackProbe collection={collection} />
            <QueryCallbackProbe collection={collection} />
            <DistinctCallbackProbe collection={collection} />
          </div>
        </LoggerProvider>,
      ),
    );

    await flushMicrotasks();
    expect(container.querySelector('[data-testid="cb-getAll-len"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-testid="cb-query-len"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-testid="cb-distinct-len"]')?.textContent).toBe('1');

    await act(async () => {
      collection.applyServerUpsert({ id: '2', name: 'Two', city: 'Y' });
    });
    await flushChange();

    expect(container.querySelector('[data-testid="cb-getAll-len"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-testid="cb-query-len"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-testid="cb-distinct-len"]')?.textContent).toBe('2');
  });

  it('debounces onChange — a burst of changes re-queries once, only after the debounce window, with the final state', async () => {
    const collection = new MockLocalCollection();
    collection.seed([{ id: 'a', name: 'A', city: 'X' }]);
    const querySpy = vi.spyOn(collection, 'query');

    container = document.createElement('div');
    root = createRoot(container);
    act(() =>
      root!.render(
        <LoggerProvider logger={undefined} loggerName="debounce-single">
          <SingleQueryProbe collection={collection} />
        </LoggerProvider>,
      ),
    );
    await flushMicrotasks();
    expect(container.querySelector('[data-testid="single-len"]')?.textContent).toBe('1');

    // Only count re-queries triggered by the burst below, not the initial-load queries.
    querySpy.mockClear();

    // Four changes in one tick — each resets the debounce timer.
    await act(async () => {
      collection.applyServerUpsert({ id: 'b', name: 'B', city: 'X' });
      collection.applyServerUpsert({ id: 'c', name: 'C', city: 'X' });
      collection.applyServerUpsert({ id: 'd', name: 'D', city: 'X' });
      collection.applyServerUpsert({ id: 'e', name: 'E', city: 'X' });
    });

    // Debounced: nothing re-queries until the window elapses.
    expect(querySpy).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="single-len"]')?.textContent).toBe('1');

    await flushChange();

    // The whole burst collapsed into a single re-query, and the final state reflects every change.
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="single-len"]')?.textContent).toBe('5');
  });

  it('debounces each subscriber independently — a shared burst still re-runs every subscriber once', async () => {
    const collection = new MockLocalCollection();
    collection.seed([{ id: 'a', name: 'A', city: 'X' }]);
    const querySpy = vi.spyOn(collection, 'query');

    container = document.createElement('div');
    root = createRoot(container);
    act(() =>
      root!.render(
        <LoggerProvider logger={undefined} loggerName="debounce-two">
          <TwoQueryProbe collection={collection} />
        </LoggerProvider>,
      ),
    );
    await flushMicrotasks();
    expect(container.querySelector('[data-testid="two-a"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-testid="two-b"]')?.textContent).toBe('1');

    querySpy.mockClear();

    await act(async () => {
      collection.applyServerUpsert({ id: 'b', name: 'B', city: 'X' });
      collection.applyServerUpsert({ id: 'c', name: 'C', city: 'X' });
    });
    await flushChange();

    // Two subscribers, each coalescing the burst to one re-query of its own → both re-run, two queries total.
    expect(querySpy).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="two-a"]')?.textContent).toBe('3');
    expect(container.querySelector('[data-testid="two-b"]')?.textContent).toBe('3');
  });

  it('cancels a pending re-query when the subscriber unmounts before the debounce fires', async () => {
    const collection = new MockLocalCollection();
    collection.seed([{ id: 'a', name: 'A', city: 'X' }]);
    const querySpy = vi.spyOn(collection, 'query');

    container = document.createElement('div');
    root = createRoot(container);
    act(() =>
      root!.render(
        <LoggerProvider logger={undefined} loggerName="debounce-unmount">
          <SingleQueryProbe collection={collection} />
        </LoggerProvider>,
      ),
    );
    await flushMicrotasks();
    querySpy.mockClear();

    // A change schedules a debounced re-query...
    await act(async () => {
      collection.applyServerUpsert({ id: 'b', name: 'B', city: 'X' });
    });
    // ...but the subscriber unmounts before the window elapses — cleanup must cancel it.
    act(() => root!.unmount());
    root = undefined;

    await flushChange();

    expect(querySpy).not.toHaveBeenCalled();
  });
});
