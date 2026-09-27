import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Record } from '@anupheaus/common';
import type { DbCollection } from '../../providers';
import { createGet } from './createGet';

/**
 * `get` reads the local store first and asks the server only for what is missing. Several components mounting
 * at once commonly ask for the same record (a list and its detail pane, every row resolving the same contact),
 * so a record that is already on its way from the server must not be requested again: concurrent gets of the
 * same id in the same collection share one server request, and each get only asks for the ids nobody is
 * already fetching.
 */

interface Row extends Record {
  id: string;
  name: string;
}

interface GetRequest {
  collectionName: string;
  ids: string[];
}

interface PendingRequest {
  request: GetRequest;
  resolve(): void;
  reject(error: Error): void;
}

const { nexus } = vi.hoisted(() => ({
  nexus: {
    isConnected: true,
    serverGet: undefined as unknown as (request: GetRequest) => Promise<string[]>,
  },
}));

vi.mock('@anupheaus/nexus/client', () => ({
  useNexus: () => ({ getIsConnected: () => nexus.isConnected }),
  useAction: () => ({ mxdbGetAction: (request: GetRequest) => nexus.serverGet(request) }),
}));

/** A local store for one collection, plus a server that holds `serverRows` and answers only when told to. */
function createScenario(name = 'contacts') {
  const localRows = new Map<string, Row>();
  const serverRows = new Map<string, Row>();
  const pending: PendingRequest[] = [];
  const dbCollection = {
    name,
    get: async (ids: string[]) => ids.map(id => localRows.get(id)).filter((row): row is Row => row != null),
  } as unknown as DbCollection<Row>;

  const serverGet = (request: GetRequest) => new Promise<string[]>((resolve, reject) => {
    pending.push({
      request,
      // Like the real action, the server pushes what it found into the local store before it answers.
      resolve: () => {
        const found = request.ids.map(id => serverRows.get(id)).filter((row): row is Row => row != null);
        found.forEach(row => localRows.set(row.id, row));
        resolve(found.map(row => row.id));
      },
      reject,
    });
  });

  return { localRows, serverRows, pending, dbCollection, serverGet };
}

const row = (id: string): Row => ({ id, name: `Row ${id}` });

/** Lets every queued microtask run, so a get has reached the server (or decided not to) before we look. */
const settle = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

describe('createGet', () => {
  let scenario: ReturnType<typeof createScenario>;

  beforeEach(() => {
    scenario = createScenario();
    nexus.isConnected = true;
    nexus.serverGet = scenario.serverGet;
  });

  it('answers from the local store without asking the server when every record is local', async () => {
    scenario.localRows.set('a', row('a'));
    const get = createGet(scenario.dbCollection);

    await expect(get('a')).resolves.toEqual(row('a'));
    expect(scenario.pending).toEqual([]);
  });

  it('asks the server only for the ids missing locally, and returns the local ones alongside', async () => {
    scenario.localRows.set('a', row('a'));
    scenario.serverRows.set('b', row('b'));
    const get = createGet(scenario.dbCollection);

    const result = get(['a', 'b']);
    await settle();
    scenario.pending.forEach(({ resolve }) => resolve());

    await expect(result).resolves.toEqual([row('a'), row('b')]);
    expect(scenario.pending.map(({ request }) => request)).toEqual([{ collectionName: 'contacts', ids: ['b'] }]);
  });

  it('shares one server request between concurrent gets of the same id', async () => {
    scenario.serverRows.set('a', row('a'));
    // Two components, each with its own useCollection — so two separate `get` functions.
    const first = createGet(scenario.dbCollection)('a');
    const second = createGet(scenario.dbCollection)('a');
    await settle();

    expect(scenario.pending).toHaveLength(1);
    scenario.pending[0]!.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([row('a'), row('a')]);
  });

  it('asks the server only for the ids no other get is already fetching', async () => {
    ['a', 'b', 'c'].forEach(id => scenario.serverRows.set(id, row(id)));
    const get = createGet(scenario.dbCollection);

    const first = get(['a', 'b']);
    await settle();
    const second = get(['b', 'c']);
    await settle();
    scenario.pending.forEach(({ resolve }) => resolve());

    expect(scenario.pending.map(({ request }) => request.ids)).toEqual([['a', 'b'], ['c']]);
    await expect(first).resolves.toEqual([row('a'), row('b')]);
    await expect(second).resolves.toEqual([row('b'), row('c')]);
  });

  it('does not wait for a slower request it does not need', async () => {
    ['a', 'b'].forEach(id => scenario.serverRows.set(id, row(id)));
    const get = createGet(scenario.dbCollection);

    void get('a');
    await settle();
    const second = get('b');
    await settle();
    scenario.pending[1]!.resolve();

    await expect(second).resolves.toEqual(row('b'));
  });

  it('asks the same id of a different collection separately', async () => {
    const other = createScenario('leads');
    scenario.serverRows.set('a', row('a'));
    other.serverRows.set('a', row('a'));
    nexus.serverGet = request => (request.collectionName === 'leads' ? other.serverGet(request) : scenario.serverGet(request));

    void createGet(scenario.dbCollection)('a');
    void createGet(other.dbCollection)('a');
    await settle();

    expect([...scenario.pending, ...other.pending].map(({ request }) => request)).toEqual([
      { collectionName: 'contacts', ids: ['a'] },
      { collectionName: 'leads', ids: ['a'] },
    ]);
  });

  it('asks the server again once an earlier request has finished — it shares requests, it does not cache answers', async () => {
    const get = createGet(scenario.dbCollection);

    const first = get('a');
    await settle();
    scenario.pending[0]!.resolve();
    await expect(first).resolves.toBeUndefined();

    scenario.serverRows.set('a', row('a'));
    const second = get('a');
    await settle();
    scenario.pending[1]!.resolve();

    await expect(second).resolves.toEqual(row('a'));
    expect(scenario.pending).toHaveLength(2);
  });

  it('fails every get sharing a failed request, and the next get tries again', async () => {
    scenario.serverRows.set('a', row('a'));
    const get = createGet(scenario.dbCollection);

    const first = get('a');
    const second = get('a');
    await settle();
    scenario.pending[0]!.reject(new Error('socket closed'));

    await expect(first).rejects.toThrow('socket closed');
    await expect(second).rejects.toThrow('socket closed');

    const retry = get('a');
    await settle();
    scenario.pending[1]!.resolve();
    await expect(retry).resolves.toEqual(row('a'));
  });

  it('asks each missing id once even when the same id is requested twice in one call', async () => {
    scenario.serverRows.set('a', row('a'));
    const get = createGet(scenario.dbCollection);

    const result = get(['a', 'a']);
    await settle();
    scenario.pending.forEach(({ resolve }) => resolve());

    await result;
    expect(scenario.pending.map(({ request }) => request.ids)).toEqual([['a']]);
  });

  it.each([
    ['offline', () => { nexus.isConnected = false; }, {}],
    ['asked to look locally only', () => { /* connected */ }, { locallyOnly: true }],
  ])('does not ask the server when %s', async (_label, arrange, props) => {
    arrange();
    const get = createGet(scenario.dbCollection);

    await expect(get('a', props)).resolves.toBeUndefined();
    expect(scenario.pending).toEqual([]);
  });
});
