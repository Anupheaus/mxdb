// @vitest-environment jsdom
import '@anupheaus/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DataRequest, Record as MXDBRecord } from '@anupheaus/common';
import { LoggerProvider } from '@anupheaus/react-ui';
import { defineCollection } from '../../../common/defineCollection';
import type { MXDBCollection, MXDBCollectionChangeEvent } from '../../../common';
import type { DistinctProps, DistinctResults, QueryResults } from '../../../common/models';
import type { MXDBCollectionEvent } from '../../providers/dbs/models';
import { DbsContext, type DbsContextProps } from '../../providers/dbs/DbContext';

// ─── Controllable socket boundary ─────────────────────────────────────────────

const { nexus } = vi.hoisted(() => ({
  nexus: {
    isConnected: true,
    actions: new Map<string, (request: unknown) => Promise<unknown>>(),
    actionCalls: [] as { name: string; request: unknown }[],
    /** Rejections from subscription callbacks; the real subscription layer does not await its callbacks. */
    callbackErrors: [] as unknown[],
    /** The most recently registered subscription callback, so a test can push a server update through it. */
    subscriptionCallback: undefined as ((response: unknown) => unknown) | undefined,
  },
}));

vi.mock('@anupheaus/nexus/client', () => ({
  useNexus: () => ({ getIsConnected: () => nexus.isConnected, isConnected: nexus.isConnected }),
  useSubscription: () => {
    let storedCallback: ((response: unknown) => unknown) | undefined;
    return {
      // Mimics the server replying straight after a subscribe (no server total, so local totals apply).
      subscribe: async () => {
        await Promise.resolve();
        void Promise.resolve(storedCallback?.(undefined)).catch(error => { nexus.callbackErrors.push(error); });
      },
      unsubscribe: () => undefined,
      onCallback: (callback: (response: unknown) => unknown) => { storedCallback = nexus.subscriptionCallback = callback; },
    };
  },
  useAction: () => new Proxy({}, {
    get: (_target, name: string) => async (request: unknown) => {
      nexus.actionCalls.push({ name, request });
      return nexus.actions.get(name)?.(request);
    },
  }),
}));

const { useCollection } = await import('./useCollection');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Fake local collection ────────────────────────────────────────────────────

interface Widget extends MXDBRecord {
  name: string;
  city: string;
}

/** In-memory stand-in for the local DbCollection: reads, change events and nothing else. */
class FakeLocalCollection {
  readonly name = 'widgets';
  readonly records = new Map<string, Widget>();
  readonly #listeners = new Set<(event: MXDBCollectionEvent<Widget>) => void>();
  queryError: Error | undefined;
  getError: Error | undefined;

  async get(ids: string[]): Promise<Widget[]> {
    if (this.getError != null) throw this.getError;
    return ids.flatMap(id => this.records.get(id) ?? []);
  }

  async getAll(): Promise<Widget[]> {
    return [...this.records.values()];
  }

  async query(_request: DataRequest<Widget>): Promise<QueryResults<Widget>> {
    if (this.queryError != null) throw this.queryError;
    const records = [...this.records.values()];
    return { records, total: records.length };
  }

  async distinct<Key extends keyof Widget>({ field }: DistinctProps<Widget, Key>): Promise<DistinctResults<Widget, Key>> {
    return [...new Set([...this.records.values()].map(record => record[field]))] as DistinctResults<Widget, Key>;
  }

  onChange(listener: (event: MXDBCollectionEvent<Widget>) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  emit(event: MXDBCollectionEvent<Widget>): void {
    for (const listener of this.#listeners) listener(event);
  }

  seed(...records: Widget[]): void {
    for (const record of records) this.records.set(record.id, record);
  }
}

const WIDGETS = defineCollection<Widget>({ name: 'widgets', indexes: [] });
const SERVER_ONLY = defineCollection<Widget>({ name: 'server-widgets', indexes: [], syncMode: 'ServerOnly' });
const UNREGISTERED = { name: 'unregistered' } as MXDBCollection<Widget>;

const alpha: Widget = { id: 'a', name: 'Alpha', city: 'London' };
const beta: Widget = { id: 'b', name: 'Beta', city: 'Paris' };

// ─── Harness ──────────────────────────────────────────────────────────────────

type CollectionApi = ReturnType<typeof useCollection<Widget>>;

const observed = { api: undefined as CollectionApi | undefined, value: undefined as unknown };

function Probe({ collection, use }: { collection: MXDBCollection<Widget>; use?(api: CollectionApi): unknown }): null {
  const collectionApi = useCollection(collection);
  observed.api = collectionApi;
  observed.value = use?.(collectionApi);
  return null;
}

let root: Root;
let local: FakeLocalCollection;

function dbsFor(collection: FakeLocalCollection): DbsContextProps {
  const db = { use: () => collection };
  return { dbs: new Map([['app', { db, collections: [] }]]) as unknown as DbsContextProps['dbs'], lastDb: 'app' };
}

function render(collection: MXDBCollection<Widget>, use?: (api: CollectionApi) => unknown): void {
  act(() => {
    root.render(
      <LoggerProvider logger={undefined} loggerName="useCollection-tests">
        <DbsContext.Provider value={dbsFor(local)}>
          <Probe collection={collection} use={use} />
        </DbsContext.Provider>
      </LoggerProvider>,
    );
  });
}

/** Comfortably past the ~50ms collection-change debounce in useSubscriptionWrapper. */
const PAST_CHANGE_DEBOUNCE_MS = 200;

async function settle(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

/** Pushes a server subscription update the way the real subscription layer does: without awaiting the callback. */
function pushSubscriptionUpdate(): void {
  const callback = nexus.subscriptionCallback;
  void Promise.resolve(callback?.(undefined)).catch(error => { nexus.callbackErrors.push(error); });
}

function api(): CollectionApi {
  return observed.api!;
}

beforeEach(() => {
  vi.useFakeTimers();
  nexus.isConnected = true;
  nexus.actions.clear();
  nexus.actionCalls = [];
  nexus.callbackErrors = [];
  nexus.subscriptionCallback = undefined;
  observed.api = undefined;
  observed.value = undefined;
  local = new FakeLocalCollection();
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

// ─── useCollection itself ─────────────────────────────────────────────────────

describe('useCollection', () => {
  it('exposes the registered collection config', () => {
    render(WIDGETS);

    expect(api().config).toEqual({ name: 'widgets', indexes: [] });
  });

  it.each([
    ['a server-only collection', SERVER_ONLY, 'Collection "server-widgets" is ServerOnly and cannot be accessed on the client.'],
    ['an unregistered collection', UNREGISTERED, 'Configuration for collection "unregistered" could not be found.'],
  ])('refuses %s', (_label, collection, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(collection)).toThrow(message);
  });
});

describe('useCollection onChange', () => {
  const translated: [string, MXDBCollectionEvent<Widget>, MXDBCollectionChangeEvent<Widget>[]][] = [
    ['an upsert', { type: 'upsert', records: [alpha], auditAction: 'default' }, [{ type: 'upsert', records: [alpha] }]],
    ['a remove', { type: 'remove', ids: ['a'], auditAction: 'markAsDeleted' }, [{ type: 'remove', recordIds: ['a'] }]],
    ['a clear of some records', { type: 'clear', ids: ['a', 'b'] }, [{ type: 'remove', recordIds: ['a', 'b'] }]],
    ['a clear of no records', { type: 'clear', ids: [] }, []],
    ['a cross-tab reload', { type: 'reload', records: [alpha] }, []],
  ];

  it.each(translated)('reports %s to subscribers as a public change event', (_label, event, expected) => {
    render(WIDGETS);
    const received: MXDBCollectionChangeEvent<Widget>[] = [];
    api().onChange(change => { received.push(change); });

    local.emit(event);

    expect(received).toEqual(expected);
  });

  it('stops reporting changes once unsubscribed', () => {
    render(WIDGETS);
    const received: MXDBCollectionChangeEvent<Widget>[] = [];
    const unsubscribe = api().onChange(change => { received.push(change); });

    unsubscribe();
    local.emit({ type: 'upsert', records: [alpha], auditAction: 'default' });

    expect(received).toEqual([]);
  });
});

// ─── get ──────────────────────────────────────────────────────────────────────

describe('useCollection get', () => {
  it('returns a record held locally without asking the server', async () => {
    local.seed(alpha);
    render(WIDGETS);

    const record = await api().get('a');

    expect({ record, serverCalls: nexus.actionCalls.length }).toEqual({ record: alpha, serverCalls: 0 });
  });

  it('fetches a record missing locally from the server when online', async () => {
    nexus.actions.set('mxdbGetAction', async () => { local.seed(beta); return ['b']; });
    render(WIDGETS);

    const record = await api().get('b');

    expect(record).toEqual(beta);
  });

  it('asks the server only for the records it was asked for', async () => {
    nexus.actions.set('mxdbGetAction', async () => []);
    render(WIDGETS);

    await api().get(['a', 'b']);

    expect(nexus.actionCalls).toEqual([{ name: 'mxdbGetAction', request: { collectionName: 'widgets', ids: ['a', 'b'] } }]);
  });

  it.each([
    ['offline', false, undefined],
    ['asked to look locally only', true, { locallyOnly: true }],
  ])('does not ask the server when %s', async (_label, isConnected, props) => {
    nexus.isConnected = isConnected;
    render(WIDGETS);

    const record = await api().get('b', props);

    expect({ record, serverCalls: nexus.actionCalls.length }).toEqual({ record: undefined, serverCalls: 0 });
  });
});

// ─── One-off reads ────────────────────────────────────────────────────────────

describe('useCollection one-off reads', () => {
  it('getAll resolves to every local record', async () => {
    local.seed(alpha, beta);
    render(WIDGETS);

    await expect(api().getAll()).resolves.toEqual([alpha, beta]);
  });

  it('query resolves to local records with the server-reported total', async () => {
    local.seed(alpha);
    nexus.actions.set('mxdbQueryAction', async () => 42);
    render(WIDGETS);

    await expect(api().query()).resolves.toEqual({ records: [alpha], total: 42 });
  });

  it('getAll resolves to no records when disabled', async () => {
    local.seed(alpha);
    render(WIDGETS);

    await expect(api().getAll({ disable: true })).resolves.toEqual([]);
  });

  it('query resolves to an empty result when disabled', async () => {
    local.seed(alpha);
    render(WIDGETS);

    await expect(api().query({ disable: true })).resolves.toEqual({ records: [], total: 0 });
  });

  it('distinct resolves to the distinct local values of a field', async () => {
    local.seed(alpha, beta, { id: 'c', name: 'Gamma', city: 'London' });
    render(WIDGETS);

    await expect(api().distinct('city')).resolves.toEqual(['London', 'Paris']);
  });

  it('distinct resolves to no values when disabled', async () => {
    local.seed(alpha);
    render(WIDGETS);

    await expect(api().distinct('city', true)).resolves.toEqual([]);
  });

  it('a disabled callback query never delivers results', async () => {
    local.seed(alpha);
    render(WIDGETS);
    const onResponse = vi.fn();

    await act(async () => { await api().query({ disable: true }, onResponse); });

    expect(onResponse).not.toHaveBeenCalled();
  });
});

// ─── Reactive hooks ───────────────────────────────────────────────────────────

describe('useCollection reactive hooks', () => {
  it('useQuery reports an empty, settled result when disabled', async () => {
    local.seed(alpha);
    render(WIDGETS, ({ useQuery }) => useQuery({ disable: true }));
    await settle();

    expect(observed.value).toEqual({ records: [], total: 0, isLoading: false, error: undefined });
  });

  it('useQuery surfaces a failing local query as an error', async () => {
    const failure = new Error('sqlite unavailable');
    local.queryError = failure;
    render(WIDGETS, ({ useQuery }) => useQuery({}));
    await settle();

    expect(observed.value).toMatchObject({ isLoading: false, error: failure });
  });

  it.each([
    ['useQuery', (collection: CollectionApi) => collection.useQuery({}), { records: [alpha], total: 1, isLoading: false, error: undefined }],
    ['useGetAll', (collection: CollectionApi) => collection.useGetAll(), { records: [alpha], isLoading: false, error: undefined }],
  ])('%s stays settled on its last result when a change leaves the result unchanged', async (_label, use, expected) => {
    local.seed(alpha);
    render(WIDGETS, use);
    await settle();

    act(() => local.emit({ type: 'upsert', records: [alpha], auditAction: 'default' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(PAST_CHANGE_DEBOUNCE_MS); });

    expect(observed.value).toEqual(expected);
  });

  it('useGetAll reports an empty, settled result when disabled', async () => {
    local.seed(alpha);
    render(WIDGETS, ({ useGetAll }) => useGetAll({ disable: true }));
    await settle();

    expect(observed.value).toEqual({ records: [], isLoading: false, error: undefined });
  });

  it('useDistinct reports the distinct values once loaded', async () => {
    local.seed(alpha, beta);
    render(WIDGETS, ({ useDistinct }) => useDistinct('city'));
    await settle();

    expect(observed.value).toEqual({ values: ['London', 'Paris'], isLoading: false, error: undefined });
  });

  it('useGet reports no record and not loading when given no id', async () => {
    render(WIDGETS, ({ useGet }) => useGet(undefined));
    await settle();

    expect(observed.value).toEqual({ record: undefined, isLoading: false, error: undefined });
  });

  it('useGet surfaces a failing lookup as an error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('read failed');
    local.getError = failure;
    render(WIDGETS, ({ useGet }) => useGet('a'));
    await settle();

    expect(observed.value).toMatchObject({ isLoading: false, error: failure });
  });

  it('useGet clears the record when it is removed', async () => {
    local.seed(alpha);
    render(WIDGETS, ({ useGet }) => useGet('a'));
    await settle();

    act(() => local.emit({ type: 'remove', ids: ['a'], auditAction: 'markAsDeleted' }));

    expect(observed.value).toEqual({ record: undefined, isLoading: false, error: undefined });
  });

  it('useGet ignores changes to other records', async () => {
    local.seed(alpha);
    render(WIDGETS, ({ useGet }) => useGet('a'));
    await settle();

    act(() => {
      local.emit({ type: 'upsert', records: [beta], auditAction: 'default' });
      local.emit({ type: 'remove', ids: ['b'], auditAction: 'markAsDeleted' });
    });

    expect(observed.value).toEqual({ record: alpha, isLoading: false, error: undefined });
  });

  it('useGet drops the record when its id is cleared', async () => {
    local.seed(alpha);
    render(WIDGETS, ({ useGet }) => useGet('a'));
    await settle();

    render(WIDGETS, ({ useGet }) => useGet(undefined));
    await settle();

    expect(observed.value).toEqual({ record: undefined, isLoading: false, error: undefined });
  });
});

// ─── useQuery re-runs ─────────────────────────────────────────────────────────

describe('useCollection useQuery re-runs', () => {
  const triggers: [string, () => Promise<void>][] = [
    ['a collection change', async () => {
      act(() => local.emit({ type: 'upsert', records: [alpha], auditAction: 'default' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(PAST_CHANGE_DEBOUNCE_MS); });
    }],
    ['a subscription update', async () => {
      await act(async () => {
        pushSubscriptionUpdate();
        await vi.advanceTimersByTimeAsync(0);
      });
    }],
  ];

  it.each(triggers)('surfaces a failed re-run triggered by %s as an error, keeping the last records', async (_label, trigger) => {
    const failure = new Error('sqlite unavailable');
    local.seed(alpha);
    render(WIDGETS, ({ useQuery }) => useQuery({}));
    await settle();

    local.queryError = failure;
    await trigger();

    expect({ state: observed.value, callbackErrors: nexus.callbackErrors })
      .toEqual({ state: { records: [alpha], total: 1, isLoading: false, error: failure }, callbackErrors: [] });
  });

  it.each(triggers)('clears the error once a re-run triggered by %s succeeds again', async (_label, trigger) => {
    local.seed(alpha);
    render(WIDGETS, ({ useQuery }) => useQuery({}));
    await settle();
    local.queryError = new Error('sqlite unavailable');
    await trigger();

    local.queryError = undefined;
    await trigger();

    expect(observed.value).toEqual({ records: [alpha], total: 1, isLoading: false, error: undefined });
  });
});

// ─── tableRequest ─────────────────────────────────────────────────────────────

describe('useCollection tableRequest', () => {
  const DEBOUNCE_MS = 100;

  it('answers a table request with the query result tagged with the request id', async () => {
    local.seed(alpha, beta);
    render(WIDGETS, ({ tableRequest }) => tableRequest({ debounceTimer: DEBOUNCE_MS }));
    const onRequest = observed.value as (request: { requestId: string }, onResponse: (response: unknown) => void) => void;
    const onResponse = vi.fn();

    await act(async () => {
      onRequest({ requestId: 'req-1' }, onResponse);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect(onResponse).toHaveBeenLastCalledWith({ records: [alpha, beta], total: 2, requestId: 'req-1' });
  });

  it('only answers the last of several rapid table requests', async () => {
    local.seed(alpha);
    render(WIDGETS, ({ tableRequest }) => tableRequest({ debounceTimer: DEBOUNCE_MS }));
    const onRequest = observed.value as (request: { requestId: string }, onResponse: (response: unknown) => void) => void;
    const onFirst = vi.fn();
    const onSecond = vi.fn();

    await act(async () => {
      onRequest({ requestId: 'req-1' }, onFirst);
      onRequest({ requestId: 'req-2' }, onSecond);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect({ first: onFirst.mock.calls.length, second: onSecond.mock.calls.length > 0 }).toEqual({ first: 0, second: true });
  });
});
