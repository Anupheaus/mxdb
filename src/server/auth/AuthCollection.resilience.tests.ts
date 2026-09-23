import { describe, it, expect } from 'vitest';
import '@anupheaus/common';
import type { NexusAuthRecord, WebAuthnAuthRecord } from '@anupheaus/nexus/common';
import type { ServerDb } from '../providers';
import { AuthCollection } from './AuthCollection';
import { WebAuthnAuthCollection } from './WebAuthnAuthCollection';
import { disableDevice, enableDevice, getDevices } from './deviceManagement';

// ─── In-memory Mongo fake ─────────────────────────────────────────────────────
// Just enough of the driver surface AuthCollection uses, with real (equality-match) query
// semantics so tests can assert on stored state rather than on driver calls.

type Doc = Record<string, unknown> & { _id: string };
type Filter = Record<string, unknown>;

interface IndexSpec {
  keys: Record<string, number>;
  options?: Record<string, unknown>;
}

function matches(doc: Doc, filter: Filter): boolean {
  return Object.entries(filter).every(([field, expected]) => {
    const actual = doc[field];
    if (expected != null && typeof expected === 'object' && !Array.isArray(expected)) {
      const { $exists, $lt } = expected as { $exists?: boolean; $lt?: number };
      if ($exists === false && actual !== undefined) return false;
      if ($exists === true && actual === undefined) return false;
      if ($lt != null && !(typeof actual === 'number' && actual < $lt)) return false;
      return true;
    }
    return actual === expected;
  });
}

function makeFakeMongoCollection() {
  const docs = new Map<string, Doc>();
  const indexes: IndexSpec[] = [];
  return {
    docs,
    indexes,
    async createIndex(keys: Record<string, number>, options?: Record<string, unknown>) { indexes.push({ keys, options }); },
    async insertOne(doc: Doc) {
      if (docs.has(doc._id)) throw new Error(`E11000 duplicate key: ${doc._id}`);
      docs.set(doc._id, structuredClone(doc));
    },
    async findOne(filter: Filter) { return [...docs.values()].find(doc => matches(doc, filter)) ?? null; },
    find(filter: Filter) { return { toArray: async () => [...docs.values()].filter(doc => matches(doc, filter)) }; },
    async updateOne(filter: Filter, update: { $set?: Filter; $unset?: Record<string, 1> }) {
      const doc = [...docs.values()].find(candidate => matches(candidate, filter));
      if (doc == null) return;
      Object.assign(doc, update.$set ?? {});
      for (const field of Object.keys(update.$unset ?? {})) delete doc[field];
    },
    async deleteOne(filter: Filter) {
      const doc = [...docs.values()].find(candidate => matches(candidate, filter));
      if (doc != null) docs.delete(doc._id);
    },
  };
}

type FakeMongoCollection = ReturnType<typeof makeFakeMongoCollection>;

interface FakeServerDbOptions {
  /** Whether `mxdb_authentication` already exists when the db is first opened. */
  hasExistingCollection?: boolean;
}

function makeFakeServerDb({ hasExistingCollection = false }: FakeServerDbOptions = {}) {
  const collection = makeFakeMongoCollection();
  const state = {
    collectionExists: hasExistingCollection,
    createCollectionCalls: 0,
    /** Errors to throw from successive `getMongoDb()` calls before succeeding. */
    getMongoDbFailures: [] as Error[],
    /** Errors to throw from successive `createCollection()` calls before succeeding. */
    createCollectionFailures: [] as Error[],
  };
  const mongoDb = {
    listCollections: (filter: { name: string }) => ({
      toArray: async () => (state.collectionExists && filter.name === 'mxdb_authentication' ? [{ name: filter.name }] : []),
    }),
    async createCollection() {
      state.createCollectionCalls++;
      const failure = state.createCollectionFailures.shift();
      if (failure != null) throw failure;
      state.collectionExists = true;
      return collection;
    },
    collection: () => collection,
  };
  const serverDb = {
    async getMongoDb() {
      const failure = state.getMongoDbFailures.shift();
      if (failure != null) throw failure;
      return mongoDb;
    },
  } as unknown as ServerDb;
  return { serverDb, collection, state };
}

class TestAuthCollection extends AuthCollection<NexusAuthRecord> { }

function makeRecord(overrides: Partial<NexusAuthRecord> = {}): NexusAuthRecord {
  return { requestId: 'req-1', sessionToken: 'tok-1', userId: 'user-1', deviceId: 'device-1', isEnabled: true, ...overrides };
}

function indexKeys(collection: FakeMongoCollection): string[] {
  return collection.indexes.map(({ keys }) => Object.keys(keys).join(',')).sort();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AuthCollection — stored records', () => {
  it('returns a created record unchanged when looked up by id', async () => {
    const { serverDb } = makeFakeServerDb();
    const authColl = new TestAuthCollection(serverDb);
    const record = makeRecord();

    await authColl.create(record);

    expect(await authColl.findById('req-1')).toEqual(record);
  });

  it.each([
    ['session token', (authColl: TestAuthCollection) => authColl.findBySessionToken('tok-2')],
    ['user + device', (authColl: TestAuthCollection) => authColl.findByDevice('user-1', 'device-2')],
  ])('finds the matching record by %s among several', async (_label, lookup) => {
    const { serverDb } = makeFakeServerDb();
    const authColl = new TestAuthCollection(serverDb);
    await authColl.create(makeRecord());
    await authColl.create(makeRecord({ requestId: 'req-2', sessionToken: 'tok-2', deviceId: 'device-2' }));

    expect((await lookup(authColl))?.requestId).toBe('req-2');
  });

  it.each([
    ['id', (authColl: TestAuthCollection) => authColl.findById('missing')],
    ['session token', (authColl: TestAuthCollection) => authColl.findBySessionToken('missing')],
    ['user + device', (authColl: TestAuthCollection) => authColl.findByDevice('user-1', 'missing')],
  ])('returns undefined when no record matches by %s', async (_label, lookup) => {
    const { serverDb } = makeFakeServerDb();
    const authColl = new TestAuthCollection(serverDb);
    await authColl.create(makeRecord());

    expect(await lookup(authColl)).toBeUndefined();
  });

  it('does not match a session token lookup against another user\'s differently-cased token', async () => {
    const { serverDb } = makeFakeServerDb();
    const authColl = new TestAuthCollection(serverDb);
    await authColl.create(makeRecord({ sessionToken: 'AbC' }));

    expect(await authColl.findBySessionToken('abc')).toBeUndefined();
  });

  it('rejects creating a second record with the same request id', async () => {
    const { serverDb } = makeFakeServerDb();
    const authColl = new TestAuthCollection(serverDb);
    await authColl.create(makeRecord());

    await expect(authColl.create(makeRecord({ sessionToken: 'other' }))).rejects.toThrow('duplicate key');
  });

  it('removes fields patched to undefined and keeps the rest', async () => {
    const { serverDb } = makeFakeServerDb();
    const authColl = new TestAuthCollection(serverDb);
    await authColl.create(makeRecord({ lastConnectedAt: 123 }));

    await authColl.update('req-1', { lastConnectedAt: undefined, sessionToken: 'tok-rotated' });

    expect(await authColl.findById('req-1')).toEqual(makeRecord({ sessionToken: 'tok-rotated' }));
  });

  it('makes a deleted record unreachable by every lookup', async () => {
    const { serverDb } = makeFakeServerDb();
    const authColl = new TestAuthCollection(serverDb);
    await authColl.create(makeRecord());

    await authColl.delete('req-1');

    expect([
      await authColl.findById('req-1'),
      await authColl.findBySessionToken('tok-1'),
      await authColl.findByDevice('user-1', 'device-1'),
    ]).toEqual([undefined, undefined, undefined]);
  });

  it('only reports disabled, never-used invites created before the cut-off as stale', async () => {
    const { serverDb } = makeFakeServerDb();
    const authColl = new TestAuthCollection(serverDb);
    const staleInvite = { requestId: 'stale', isEnabled: false, createdAt: 100 };
    await authColl.create(makeRecord(staleInvite) as NexusAuthRecord);
    await authColl.create(makeRecord({ requestId: 'fresh', isEnabled: false, createdAt: 5_000 } as Partial<NexusAuthRecord>));
    await authColl.create(makeRecord({ requestId: 'enabled', isEnabled: true, createdAt: 100 } as Partial<NexusAuthRecord>));
    await authColl.create(makeRecord({ requestId: 'used', isEnabled: false, createdAt: 100, lastConnectedAt: 200 } as Partial<NexusAuthRecord>));
    await authColl.create(makeRecord({ requestId: 'registered', isEnabled: false, createdAt: 100, deviceDetails: {} } as Partial<NexusAuthRecord>));

    const stale = await authColl.findStalePendingInvites(1_000);

    expect(stale.map(({ requestId }) => requestId)).toEqual(['stale']);
  });
});

describe('AuthCollection — first-use setup', () => {
  it('creates the auth collection with lookup indexes when it does not exist yet', async () => {
    const { serverDb, collection, state } = makeFakeServerDb({ hasExistingCollection: false });

    await new TestAuthCollection(serverDb).findById('any');

    expect(state.createCollectionCalls).toBe(1);
    expect(indexKeys(collection)).toEqual(['deviceId', 'sessionToken', 'userId']);
  });

  it('adds the webauthn registration-token and key-hash indexes for webauthn stores', async () => {
    const { serverDb, collection } = makeFakeServerDb({ hasExistingCollection: false });

    await new WebAuthnAuthCollection(serverDb).findById('any');

    expect(indexKeys(collection)).toEqual(['deviceId', 'keyHash', 'registrationToken', 'sessionToken', 'userId']);
  });

  it('reuses an existing auth collection without recreating it', async () => {
    const { serverDb, state } = makeFakeServerDb({ hasExistingCollection: true });

    await new TestAuthCollection(serverDb).findById('any');

    expect(state.createCollectionCalls).toBe(0);
  });

  it('creates the collection only once when many auth queries arrive concurrently on a cold start', async () => {
    const { serverDb, state } = makeFakeServerDb({ hasExistingCollection: false });
    const authColl = new TestAuthCollection(serverDb);

    await Promise.all(Array.from({ length: 10 }, (_, index) => authColl.findBySessionToken(`tok-${index}`)));

    expect(state.createCollectionCalls).toBe(1);
  });
});

describe('AuthCollection — recovery from transient database failures', () => {
  // A transient failure while opening the collection (Mongo blip on startup, or another
  // server instance winning the race to create the collection) must fail only the query
  // that hit it — not poison every later auth lookup until the process restarts.

  it('serves later lookups after the database connection fails once', async () => {
    const { serverDb, state } = makeFakeServerDb({ hasExistingCollection: true });
    const authColl = new TestAuthCollection(serverDb);
    state.getMongoDbFailures.push(new Error('connection reset'));

    await expect(authColl.findById('req-1')).rejects.toThrow('connection reset');

    await expect(authColl.findById('req-1')).resolves.toBeUndefined();
  });

  it('serves later lookups after creating the collection fails once', async () => {
    const { serverDb, state } = makeFakeServerDb({ hasExistingCollection: false });
    const authColl = new TestAuthCollection(serverDb);
    state.createCollectionFailures.push(new Error('NamespaceExists: collection already exists'));

    await expect(authColl.findById('req-1')).rejects.toThrow('NamespaceExists');

    await expect(authColl.findById('req-1')).resolves.toBeUndefined();
  });
});

describe('deviceManagement against a real auth store', () => {
  async function seedDevices() {
    const { serverDb } = makeFakeServerDb();
    const authColl = new WebAuthnAuthCollection(serverDb);
    const phone: WebAuthnAuthRecord = {
      requestId: 'req-phone', sessionToken: 'tok-phone', userId: 'user-1', deviceId: 'phone',
      isEnabled: true, deviceDetails: { name: 'Phone' } as unknown as WebAuthnAuthRecord['deviceDetails'], lastConnectedAt: 1_000, keyHash: 'secret-hash',
    };
    const laptop: WebAuthnAuthRecord = {
      requestId: 'req-laptop', sessionToken: 'tok-laptop', userId: 'user-1', deviceId: 'laptop', isEnabled: false,
    };
    const otherUser: WebAuthnAuthRecord = {
      requestId: 'req-other', sessionToken: 'tok-other', userId: 'user-2', deviceId: 'phone', isEnabled: true,
    };
    await authColl.create(phone);
    await authColl.create(laptop);
    await authColl.create(otherUser);
    return { authColl: authColl as unknown as AuthCollection<NexusAuthRecord> };
  }

  it('lists only the requested user\'s devices', async () => {
    const { authColl } = await seedDevices();

    const devices = await getDevices(authColl, 'user-1');

    expect(devices.map(({ requestId }) => requestId).sort()).toEqual(['req-laptop', 'req-phone']);
  });

  it('exposes device info without leaking session tokens or key hashes', async () => {
    const { authColl } = await seedDevices();

    const devices = await getDevices(authColl, 'user-1');

    expect(devices.find(({ requestId }) => requestId === 'req-phone')).toEqual({
      requestId: 'req-phone', userId: 'user-1', deviceDetails: { name: 'Phone' }, isEnabled: true, lastConnectedAt: 1_000,
    });
  });

  it('returns an empty list for a user with no devices', async () => {
    const { authColl } = await seedDevices();
    expect(await getDevices(authColl, 'user-unknown')).toEqual([]);
  });

  it('disabling a device only affects that device', async () => {
    const { authColl } = await seedDevices();

    await disableDevice(authColl, 'req-phone');

    const devices = await getDevices(authColl, 'user-1');
    expect(devices.map(({ requestId, isEnabled }) => [requestId, isEnabled]).sort()).toEqual([['req-laptop', false], ['req-phone', false]]);
  });

  it('enabling a disabled device marks it enabled', async () => {
    const { authColl } = await seedDevices();

    await enableDevice(authColl, 'req-laptop');

    expect((await authColl.findById('req-laptop'))?.isEnabled).toBe(true);
  });
});
