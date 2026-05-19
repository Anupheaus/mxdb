# Multi-Auth-Mode Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor mxdb-sync so `AuthCollection` is a generic base class with `WebAuthnAuthCollection` and `GoogleOAuthAuthCollection` subclasses, and `ServerConfig` accepts a discriminated union `auth` field so either mode can be wired up without code changes.

**Architecture:** `AuthCollection<TRecord>` is an abstract class implementing `SocketAPIAuthStore<TRecord>` with shared CRUD and an internal `findAllByUserId` helper. Each auth mode subclass extends it and adds the extra store-interface methods required by socket-api. `ServerConfig.auth` is a `WebAuthnServerAuthConfig | GoogleOAuthServerAuthConfig` discriminated union; `startAuthenticatedServer` branches on `auth.mode` to instantiate the correct subclass and call `configureAuthentication` with the right options. Client-side `MXDBSync` gets an `authMode` prop so it can skip PRF/key-derivation for Google OAuth and mount `DbsProvider` as soon as the user is authenticated.

**Tech Stack:** TypeScript, MongoDB driver, Vitest, socket-api (`@anupheaus/nexus`), React

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/server/auth/AuthCollection.ts` | Generic base class — shared CRUD + `findAllByUserId` |
| Create | `src/server/auth/WebAuthnAuthCollection.ts` | WebAuthn-specific lookups (`findByRegistrationToken`, `findByKeyHash`) + array `findByUserId` |
| Create | `src/server/auth/GoogleOAuthAuthCollection.ts` | Google OAuth `findByUserId` (single record) |
| Create | `src/server/auth/AuthCollection.tests.ts` | Unit tests for base class CRUD |
| Create | `src/server/auth/WebAuthnAuthCollection.tests.ts` | Unit tests for WebAuthn-specific methods |
| Create | `src/server/auth/GoogleOAuthAuthCollection.tests.ts` | Unit tests for Google OAuth-specific method |
| Modify | `src/common/models/authModels.ts` | Add `MXDBGoogleOAuthAuthRecord`; update `MXDBAuthRecord` to reflect base fields |
| Modify | `src/server/internalModels.ts` | Replace scattered auth fields with `auth: WebAuthnServerAuthConfig \| GoogleOAuthServerAuthConfig`; make `createInvite` optional on `ServerInstance` |
| Modify | `src/server/startAuthenticatedServer.ts` | Branch on `auth.mode`, instantiate correct subclass, call `configureAuthentication` correctly |
| Modify | `src/server/auth/registerDevAuthRoute.ts` | Accept `authColl` + mode; create correct record type per mode |
| Modify | `src/server/auth/deviceManagement.ts` | Accept `AuthCollection` instead of `ServerDb`; use `findAllByUserId` |
| Modify | `src/server/startServer.ts` | Pass `authColl` to device management; remove duplicate `registerDevAuthRoute` call |
| Modify | `src/client/MXDBSync.tsx` | Add `authMode` prop; skip `onPrf` for Google OAuth |
| Modify | `src/client/auth/MXDBSyncInner.tsx` | Mount `DbsProvider` immediately on sign-in when `authMode === 'google-oauth'` |
| Modify | `test/server/start.ts` | Update to new `auth: { mode: 'webauthn', ... }` config shape |

---

## Task 1: Refactor `AuthCollection` into a generic base class

**Files:**
- Modify: `src/server/auth/AuthCollection.ts`
- Create: `src/server/auth/AuthCollection.tests.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/auth/AuthCollection.tests.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SocketAPIAuthRecord } from '@anupheaus/nexus/common/auth';
import type { ServerDb } from '../providers';

// Minimal concrete subclass used only in tests — no extra methods needed.
let AuthCollection: any;

const mockInsertOne = vi.fn();
const mockFindOne = vi.fn();
const mockFind = vi.fn();
const mockUpdateOne = vi.fn();
const mockCreateIndex = vi.fn();
const mockListCollections = vi.fn();
const mockCreateCollection = vi.fn();
const mockGetCollection = vi.fn();

const fakeCollection = {
  insertOne: mockInsertOne,
  findOne: mockFindOne,
  find: mockFind,
  updateOne: mockUpdateOne,
  createIndex: mockCreateIndex,
};
mockFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
mockListCollections.mockReturnValue({ toArray: vi.fn().mockResolvedValue([{ name: 'mxdb_authentication' }]) });
mockGetCollection.mockReturnValue(fakeCollection);
mockCreateCollection.mockResolvedValue(fakeCollection);

const fakeDb = {
  getMongoDb: vi.fn().mockResolvedValue({
    listCollections: mockListCollections,
    createCollection: mockCreateCollection,
    collection: mockGetCollection,
  }),
} as unknown as ServerDb;

beforeEach(async () => {
  vi.clearAllMocks();
  mockListCollections.mockReturnValue({ toArray: vi.fn().mockResolvedValue([{ name: 'mxdb_authentication' }]) });
  mockGetCollection.mockReturnValue(fakeCollection);
  mockFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
  const mod = await import('./AuthCollection');
  AuthCollection = mod.AuthCollection;
});

type TestRecord = SocketAPIAuthRecord; // uses the base shape

describe('AuthCollection (base class)', () => {
  it('create: inserts the record as a doc with _id = requestId', async () => {
    const coll = new AuthCollection(fakeDb);
    const record: TestRecord = {
      requestId: 'req-1', sessionToken: 'tok', userId: 'u1',
      deviceId: 'dev', isEnabled: true,
    };
    await coll.create(record);
    expect(mockInsertOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'req-1', sessionToken: 'tok', userId: 'u1' })
    );
    expect(mockInsertOne.mock.calls[0][0]).not.toHaveProperty('requestId');
  });

  it('findById: returns undefined when not found', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new AuthCollection(fakeDb);
    expect(await coll.findById('missing')).toBeUndefined();
  });

  it('findById: maps _id back to requestId', async () => {
    mockFindOne.mockResolvedValue({ _id: 'req-1', sessionToken: 'tok', userId: 'u1', deviceId: 'dev', isEnabled: true });
    const coll = new AuthCollection(fakeDb);
    const result = await coll.findById('req-1');
    expect(result).toEqual(expect.objectContaining({ requestId: 'req-1', sessionToken: 'tok' }));
    expect(result).not.toHaveProperty('_id');
  });

  it('findBySessionToken: queries by sessionToken', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new AuthCollection(fakeDb);
    await coll.findBySessionToken('tok');
    expect(mockFindOne).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: 'tok' }));
  });

  it('findByDevice: queries by userId and deviceId', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new AuthCollection(fakeDb);
    await coll.findByDevice('u1', 'dev');
    expect(mockFindOne).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', deviceId: 'dev' }));
  });

  it('findAllByUserId: returns all matching records', async () => {
    const docs = [
      { _id: 'req-1', sessionToken: 't1', userId: 'u1', deviceId: 'dev', isEnabled: true },
      { _id: 'req-2', sessionToken: 't2', userId: 'u1', deviceId: 'dev2', isEnabled: true },
    ];
    mockFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue(docs) });
    const coll = new AuthCollection(fakeDb);
    const results = await coll.findAllByUserId('u1');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(expect.objectContaining({ requestId: 'req-1' }));
    expect(results[1]).toEqual(expect.objectContaining({ requestId: 'req-2' }));
  });

  it('update: $set fields that have a value and $unset fields that are undefined', async () => {
    const coll = new AuthCollection(fakeDb);
    await coll.update('req-1', { sessionToken: 'new-tok', deviceDetails: undefined });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'req-1' }),
      expect.objectContaining({ $set: { sessionToken: 'new-tok' }, $unset: { deviceDetails: 1 } })
    );
  });

  it('update: skips the mongo call when patch is empty', async () => {
    const coll = new AuthCollection(fakeDb);
    await coll.update('req-1', {});
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests — expect them to fail**

```
pnpm test src/server/auth/AuthCollection.tests.ts
```

Expected: FAIL — `AuthCollection` not yet a generic base class / missing `findAllByUserId`.

- [ ] **Step 3: Rewrite `AuthCollection.ts` as an abstract generic base class**

Replace the entire contents of `src/server/auth/AuthCollection.ts`:

```ts
import type { Collection } from 'mongodb';
import type { SocketAPIAuthRecord, SocketAPIAuthStore } from '@anupheaus/nexus/common/auth';
import type { ServerDb } from '../providers';

const COLLECTION_NAME = 'mxdb_authentication';

type AuthDoc<TRecord extends SocketAPIAuthRecord> = Omit<TRecord, 'requestId'> & { _id: string };

function toDoc<TRecord extends SocketAPIAuthRecord>(record: TRecord): AuthDoc<TRecord> {
  const { requestId, ...rest } = record;
  return { _id: requestId, ...rest } as AuthDoc<TRecord>;
}

function fromDoc<TRecord extends SocketAPIAuthRecord>(doc: AuthDoc<TRecord>): TRecord {
  const { _id, ...rest } = doc;
  return { requestId: _id, ...rest } as TRecord;
}

export abstract class AuthCollection<TRecord extends SocketAPIAuthRecord>
  implements SocketAPIAuthStore<TRecord> {

  constructor(db: ServerDb) {
    this._coll = this.#init(db);
  }

  protected _coll: Promise<Collection<AuthDoc<TRecord>>>;

  async #init(serverDb: ServerDb): Promise<Collection<AuthDoc<TRecord>>> {
    const db = await serverDb.getMongoDb();
    const names = await db.listCollections({ name: COLLECTION_NAME }).toArray();
    if (names.length === 0) {
      const coll = await db.createCollection<AuthDoc<TRecord>>(COLLECTION_NAME);
      await this.createIndexes(coll);
      return coll;
    }
    return db.collection<AuthDoc<TRecord>>(COLLECTION_NAME);
  }

  protected async createIndexes(coll: Collection<AuthDoc<TRecord>>): Promise<void> {
    await coll.createIndex({ userId: 1 });
    await coll.createIndex({ sessionToken: 1 }, { sparse: true });
    await coll.createIndex({ deviceId: 1 }, { sparse: true });
  }

  async create(record: TRecord): Promise<void> {
    const coll = await this._coll;
    await coll.insertOne(toDoc(record) as any);
  }

  async findById(requestId: string): Promise<TRecord | undefined> {
    const coll = await this._coll;
    const doc = await coll.findOne({ _id: requestId } as any);
    return doc ? fromDoc(doc) : undefined;
  }

  async findBySessionToken(token: string): Promise<TRecord | undefined> {
    const coll = await this._coll;
    const doc = await coll.findOne({ sessionToken: token } as any);
    return doc ? fromDoc(doc) : undefined;
  }

  async findByDevice(userId: string, deviceId: string): Promise<TRecord | undefined> {
    const coll = await this._coll;
    const doc = await coll.findOne({ userId, deviceId } as any);
    return doc ? fromDoc(doc) : undefined;
  }

  async findAllByUserId(userId: string): Promise<TRecord[]> {
    const coll = await this._coll;
    const docs = await coll.find({ userId } as any).toArray();
    return docs.map(fromDoc);
  }

  async update(requestId: string, patch: Partial<TRecord>): Promise<void> {
    const coll = await this._coll;
    const setFields: Record<string, unknown> = {};
    const unsetFields: Record<string, 1> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) unsetFields[key] = 1;
      else setFields[key] = value;
    }
    const update: Record<string, unknown> = {};
    if (Object.keys(setFields).length > 0) update['$set'] = setFields;
    if (Object.keys(unsetFields).length > 0) update['$unset'] = unsetFields;
    if (Object.keys(update).length > 0) {
      await coll.updateOne({ _id: requestId } as any, update);
    }
  }
}
```

> Note: The class is `abstract` so it cannot be instantiated directly. Subclasses use `super(db)` to initialise the shared collection infrastructure. The test file needs a concrete subclass — add this inside the test file (not exported):
>
> In `AuthCollection.tests.ts`, add after the imports:
> ```ts
> // Minimal concrete subclass for testing the base class in isolation
> class ConcreteAuthCollection extends (await import('./AuthCollection')).AuthCollection<SocketAPIAuthRecord> { }
> ```
>
> But since we use `await import` inside `beforeEach`, we can just call `new AuthCollection(fakeDb)` after the import. Actually the class is abstract — we need a tiny concrete subclass in the test. Update the test's `beforeEach` to define a local concrete class:

Update `AuthCollection.tests.ts` — replace the `beforeEach` block:

```ts
class ConcreteAuthCollection<T extends SocketAPIAuthRecord> extends (mod.AuthCollection as any)<T> { }
// then in new-up lines replace:
const coll = new AuthCollection(fakeDb);
// with:
const coll = new ConcreteAuthCollection(fakeDb);
```

Full updated test file with the concrete subclass approach:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SocketAPIAuthRecord } from '@anupheaus/nexus/common/auth';
import type { ServerDb } from '../providers';
import type { AuthCollection as AuthCollectionType } from './AuthCollection';

const mockInsertOne = vi.fn();
const mockFindOne = vi.fn();
const mockFind = vi.fn();
const mockUpdateOne = vi.fn();
const mockCreateIndex = vi.fn();
const mockListCollections = vi.fn();
const mockGetCollection = vi.fn();

const fakeCollection = {
  insertOne: mockInsertOne,
  findOne: mockFindOne,
  find: mockFind,
  updateOne: mockUpdateOne,
  createIndex: mockCreateIndex,
};

function makeFakeDb(): ServerDb {
  mockListCollections.mockReturnValue({
    toArray: vi.fn().mockResolvedValue([{ name: 'mxdb_authentication' }]),
  });
  mockFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
  mockGetCollection.mockReturnValue(fakeCollection);
  return {
    getMongoDb: vi.fn().mockResolvedValue({
      listCollections: mockListCollections,
      createCollection: vi.fn().mockResolvedValue(fakeCollection),
      collection: mockGetCollection,
    }),
  } as unknown as ServerDb;
}

let ConcreteCollection: new (db: ServerDb) => AuthCollectionType<SocketAPIAuthRecord>;

beforeEach(async () => {
  vi.clearAllMocks();
  const { AuthCollection } = await import('./AuthCollection');
  // Minimal concrete subclass — satisfies abstract constraint for testing base behaviour
  ConcreteCollection = class extends (AuthCollection as any)<SocketAPIAuthRecord> { };
});

describe('AuthCollection (base class)', () => {
  it('create: inserts doc with _id = requestId and no requestId field', async () => {
    const coll = new ConcreteCollection(makeFakeDb());
    const record: SocketAPIAuthRecord = {
      requestId: 'req-1', sessionToken: 'tok', userId: 'u1',
      deviceId: 'dev', isEnabled: true,
    };
    await coll.create(record);
    expect(mockInsertOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'req-1', sessionToken: 'tok' })
    );
    expect(mockInsertOne.mock.calls[0][0]).not.toHaveProperty('requestId');
  });

  it('findById: returns undefined when document not found', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new ConcreteCollection(makeFakeDb());
    expect(await coll.findById('missing')).toBeUndefined();
  });

  it('findById: maps _id back to requestId', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'req-1', sessionToken: 'tok', userId: 'u1', deviceId: 'dev', isEnabled: true,
    });
    const coll = new ConcreteCollection(makeFakeDb());
    const result = await coll.findById('req-1');
    expect(result).toEqual(expect.objectContaining({ requestId: 'req-1' }));
    expect(result).not.toHaveProperty('_id');
  });

  it('findBySessionToken: queries by sessionToken field', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new ConcreteCollection(makeFakeDb());
    await coll.findBySessionToken('tok');
    expect(mockFindOne).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: 'tok' }));
  });

  it('findByDevice: queries by userId and deviceId', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new ConcreteCollection(makeFakeDb());
    await coll.findByDevice('u1', 'dev');
    expect(mockFindOne).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', deviceId: 'dev' }));
  });

  it('findAllByUserId: returns all matching records mapped from docs', async () => {
    mockFind.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        { _id: 'req-1', sessionToken: 't1', userId: 'u1', deviceId: 'd1', isEnabled: true },
        { _id: 'req-2', sessionToken: 't2', userId: 'u1', deviceId: 'd2', isEnabled: true },
      ]),
    });
    const coll = new ConcreteCollection(makeFakeDb());
    const results = await coll.findAllByUserId('u1');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(expect.objectContaining({ requestId: 'req-1' }));
    expect(results[1]).toEqual(expect.objectContaining({ requestId: 'req-2' }));
  });

  it('update: $set valued fields and $unset undefined fields', async () => {
    const coll = new ConcreteCollection(makeFakeDb());
    await coll.update('req-1', { sessionToken: 'new', deviceDetails: undefined });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'req-1' }),
      expect.objectContaining({ $set: { sessionToken: 'new' }, $unset: { deviceDetails: 1 } })
    );
  });

  it('update: does not call updateOne when patch is empty', async () => {
    const coll = new ConcreteCollection(makeFakeDb());
    await coll.update('req-1', {});
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run tests — expect them to pass**

```
pnpm test src/server/auth/AuthCollection.tests.ts
```

Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```
git add src/server/auth/AuthCollection.ts src/server/auth/AuthCollection.tests.ts
git commit -m "refactor(auth): make AuthCollection a generic abstract base class with findAllByUserId"
```

---

## Task 2: Create `WebAuthnAuthCollection`

**Files:**
- Create: `src/server/auth/WebAuthnAuthCollection.ts`
- Create: `src/server/auth/WebAuthnAuthCollection.tests.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/auth/WebAuthnAuthCollection.tests.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebAuthnAuthRecord } from '@anupheaus/nexus/common/auth';
import type { ServerDb } from '../providers';

const mockFindOne = vi.fn();
const mockFind = vi.fn();
const mockInsertOne = vi.fn();
const mockUpdateOne = vi.fn();
const mockListCollections = vi.fn();
const mockGetCollection = vi.fn();

const fakeCollection = {
  insertOne: mockInsertOne,
  findOne: mockFindOne,
  find: mockFind,
  updateOne: mockUpdateOne,
  createIndex: vi.fn(),
};

function makeFakeDb(): ServerDb {
  mockListCollections.mockReturnValue({
    toArray: vi.fn().mockResolvedValue([{ name: 'mxdb_authentication' }]),
  });
  mockFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
  mockGetCollection.mockReturnValue(fakeCollection);
  return {
    getMongoDb: vi.fn().mockResolvedValue({
      listCollections: mockListCollections,
      createCollection: vi.fn().mockResolvedValue(fakeCollection),
      collection: mockGetCollection,
    }),
  } as unknown as ServerDb;
}

let WebAuthnAuthCollection: new (db: ServerDb) => import('./WebAuthnAuthCollection').WebAuthnAuthCollection;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ WebAuthnAuthCollection } = await import('./WebAuthnAuthCollection'));
});

const baseRecord: WebAuthnAuthRecord = {
  requestId: 'req-1', sessionToken: 'tok', userId: 'u1',
  deviceId: 'dev', isEnabled: true,
};

describe('WebAuthnAuthCollection', () => {
  it('findByRegistrationToken: queries by registrationToken field', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new WebAuthnAuthCollection(makeFakeDb());
    await coll.findByRegistrationToken('reg-tok');
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ registrationToken: 'reg-tok' })
    );
  });

  it('findByRegistrationToken: returns undefined when not found', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new WebAuthnAuthCollection(makeFakeDb());
    expect(await coll.findByRegistrationToken('none')).toBeUndefined();
  });

  it('findByRegistrationToken: maps _id back to requestId', async () => {
    mockFindOne.mockResolvedValue({ ...baseRecord, _id: 'req-1', registrationToken: 'reg-tok' });
    const coll = new WebAuthnAuthCollection(makeFakeDb());
    const result = await coll.findByRegistrationToken('reg-tok');
    expect(result).toEqual(expect.objectContaining({ requestId: 'req-1' }));
  });

  it('findByKeyHash: queries by keyHash field', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new WebAuthnAuthCollection(makeFakeDb());
    await coll.findByKeyHash('hash-abc');
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ keyHash: 'hash-abc' })
    );
  });

  it('findByKeyHash: returns undefined when not found', async () => {
    mockFindOne.mockResolvedValue(null);
    const coll = new WebAuthnAuthCollection(makeFakeDb());
    expect(await coll.findByKeyHash('none')).toBeUndefined();
  });

  it('findByUserId: returns all records for a userId as an array', async () => {
    mockFind.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        { _id: 'req-1', ...baseRecord },
        { _id: 'req-2', ...baseRecord, sessionToken: 'tok2', deviceId: 'dev2' },
      ]),
    });
    const coll = new WebAuthnAuthCollection(makeFakeDb());
    const results = await coll.findByUserId('u1');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(expect.objectContaining({ requestId: 'req-1' }));
  });
});
```

- [ ] **Step 2: Run tests — expect them to fail**

```
pnpm test src/server/auth/WebAuthnAuthCollection.tests.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `WebAuthnAuthCollection.ts`**

Create `src/server/auth/WebAuthnAuthCollection.ts`:

```ts
import type { Collection } from 'mongodb';
import type { WebAuthnAuthRecord, WebAuthnAuthStore } from '@anupheaus/nexus/common/auth';
import type { ServerDb } from '../providers';
import { AuthCollection } from './AuthCollection';

type WebAuthnAuthDoc = Omit<WebAuthnAuthRecord, 'requestId'> & { _id: string };

export class WebAuthnAuthCollection extends AuthCollection<WebAuthnAuthRecord>
  implements WebAuthnAuthStore {

  constructor(db: ServerDb) {
    super(db);
  }

  protected override async createIndexes(coll: Collection<WebAuthnAuthDoc>): Promise<void> {
    await super.createIndexes(coll as any);
    await coll.createIndex({ registrationToken: 1 }, { sparse: true });
    await coll.createIndex({ keyHash: 1 }, { sparse: true });
  }

  async findByRegistrationToken(registrationToken: string): Promise<WebAuthnAuthRecord | undefined> {
    const coll = await this._coll as Collection<WebAuthnAuthDoc>;
    const doc = await coll.findOne({ registrationToken } as any);
    if (doc == null) return undefined;
    const { _id, ...rest } = doc;
    return { requestId: _id, ...rest };
  }

  async findByKeyHash(keyHash: string): Promise<WebAuthnAuthRecord | undefined> {
    const coll = await this._coll as Collection<WebAuthnAuthDoc>;
    const doc = await coll.findOne({ keyHash } as any);
    if (doc == null) return undefined;
    const { _id, ...rest } = doc;
    return { requestId: _id, ...rest };
  }

  async findByUserId(userId: string): Promise<WebAuthnAuthRecord[]> {
    return this.findAllByUserId(userId);
  }
}
```

- [ ] **Step 4: Run tests — expect them to pass**

```
pnpm test src/server/auth/WebAuthnAuthCollection.tests.ts
```

Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```
git add src/server/auth/WebAuthnAuthCollection.ts src/server/auth/WebAuthnAuthCollection.tests.ts
git commit -m "feat(auth): add WebAuthnAuthCollection subclass"
```

---

## Task 3: Create `GoogleOAuthAuthCollection`

**Files:**
- Create: `src/server/auth/GoogleOAuthAuthCollection.ts`
- Create: `src/server/auth/GoogleOAuthAuthCollection.tests.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/auth/GoogleOAuthAuthCollection.tests.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GoogleOAuthAuthRecord } from '@anupheaus/nexus/common/auth';
import type { ServerDb } from '../providers';

const mockFindOne = vi.fn();
const mockFind = vi.fn();
const mockListCollections = vi.fn();
const mockGetCollection = vi.fn();

const fakeCollection = {
  insertOne: vi.fn(),
  findOne: mockFindOne,
  find: mockFind,
  updateOne: vi.fn(),
  createIndex: vi.fn(),
};

function makeFakeDb(): ServerDb {
  mockListCollections.mockReturnValue({
    toArray: vi.fn().mockResolvedValue([{ name: 'mxdb_authentication' }]),
  });
  mockFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
  mockGetCollection.mockReturnValue(fakeCollection);
  return {
    getMongoDb: vi.fn().mockResolvedValue({
      listCollections: mockListCollections,
      createCollection: vi.fn().mockResolvedValue(fakeCollection),
      collection: mockGetCollection,
    }),
  } as unknown as ServerDb;
}

let GoogleOAuthAuthCollection: new (db: ServerDb) => import('./GoogleOAuthAuthCollection').GoogleOAuthAuthCollection;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ GoogleOAuthAuthCollection } = await import('./GoogleOAuthAuthCollection'));
});

const baseRecord: GoogleOAuthAuthRecord = {
  requestId: 'req-1', sessionToken: 'tok', userId: 'u1',
  deviceId: 'dev', isEnabled: true,
  googleAccessToken: 'gat', googleRefreshToken: 'grt',
  googleTokenExpiresAt: 9999999, grantedScopes: ['openid'],
};

describe('GoogleOAuthAuthCollection', () => {
  it('findByUserId: returns undefined when no record exists for the user', async () => {
    mockFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
    const coll = new GoogleOAuthAuthCollection(makeFakeDb());
    expect(await coll.findByUserId('u1')).toBeUndefined();
  });

  it('findByUserId: returns the single record when one exists', async () => {
    mockFind.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([{ ...baseRecord, _id: 'req-1' }]),
    });
    const coll = new GoogleOAuthAuthCollection(makeFakeDb());
    const result = await coll.findByUserId('u1');
    expect(result).toEqual(expect.objectContaining({ requestId: 'req-1', googleAccessToken: 'gat' }));
  });

  it('findByUserId: returns the first record when multiple exist (defensive)', async () => {
    mockFind.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        { ...baseRecord, _id: 'req-1' },
        { ...baseRecord, _id: 'req-2', sessionToken: 'tok2' },
      ]),
    });
    const coll = new GoogleOAuthAuthCollection(makeFakeDb());
    const result = await coll.findByUserId('u1');
    expect(result).toEqual(expect.objectContaining({ requestId: 'req-1' }));
  });
});
```

- [ ] **Step 2: Run tests — expect them to fail**

```
pnpm test src/server/auth/GoogleOAuthAuthCollection.tests.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `GoogleOAuthAuthCollection.ts`**

Create `src/server/auth/GoogleOAuthAuthCollection.ts`:

```ts
import type { GoogleOAuthAuthRecord, GoogleOAuthAuthStore } from '@anupheaus/nexus/common/auth';
import type { ServerDb } from '../providers';
import { AuthCollection } from './AuthCollection';

export class GoogleOAuthAuthCollection extends AuthCollection<GoogleOAuthAuthRecord>
  implements GoogleOAuthAuthStore {

  constructor(db: ServerDb) {
    super(db);
  }

  async findByUserId(userId: string): Promise<GoogleOAuthAuthRecord | undefined> {
    const records = await this.findAllByUserId(userId);
    return records[0];
  }
}
```

- [ ] **Step 4: Run tests — expect them to pass**

```
pnpm test src/server/auth/GoogleOAuthAuthCollection.tests.ts
```

Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```
git add src/server/auth/GoogleOAuthAuthCollection.ts src/server/auth/GoogleOAuthAuthCollection.tests.ts
git commit -m "feat(auth): add GoogleOAuthAuthCollection subclass"
```

---

## Task 4: Update auth models

**Files:**
- Modify: `src/common/models/authModels.ts`

- [ ] **Step 1: Update `authModels.ts`**

Replace the contents of `src/common/models/authModels.ts`:

```ts
import type { SocketAPIAccount, SocketAPIUser } from '@anupheaus/nexus/common';

export interface MXDBUser extends SocketAPIUser { }

export interface MXDBAccount extends SocketAPIAccount { }

/**
 * Base shape for an `mxdb_authentication` document — matches `SocketAPIAuthRecord`.
 * Used for device-management APIs that work regardless of auth mode.
 */
export interface MXDBAuthRecord {
  requestId: string;
  userId: string;
  sessionToken: string;
  deviceId: string;
  deviceDetails?: unknown;
  isEnabled: boolean;
  lastConnectedAt?: number;
  accountId?: string;
}

/**
 * Extra fields stored when the server is running in `google-oauth` mode.
 */
export interface MXDBGoogleOAuthAuthRecord extends MXDBAuthRecord {
  googleAccessToken: string;
  googleRefreshToken: string;
  /** Unix timestamp (ms) when `googleAccessToken` expires. */
  googleTokenExpiresAt: number;
  grantedScopes: string[];
}

export interface MXDBDeviceInfo {
  requestId: string;
  userId: string;
  deviceDetails?: unknown;
  isEnabled: boolean;
  lastConnectedAt?: number;
}
```

- [ ] **Step 2: Run full unit tests to confirm no regressions**

```
pnpm test:ci
```

Expected: all previously-passing tests still pass.

- [ ] **Step 3: Commit**

```
git add src/common/models/authModels.ts
git commit -m "feat(auth): add MXDBGoogleOAuthAuthRecord; align MXDBAuthRecord with base SocketAPIAuthRecord shape"
```

---

## Task 5: Update `internalModels.ts` — discriminated union `ServerConfig.auth`

**Files:**
- Modify: `src/server/internalModels.ts`

- [ ] **Step 1: Update `internalModels.ts`**

Replace the contents of `src/server/internalModels.ts`:

```ts
import type { Http2Server } from 'http2';
import type { Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';
import type { MXDBAccount, MXDBDeviceInfo, MXDBUser } from '../common/models';
import type { MXDBCollection } from '../common';
import type { ServerConfig as StartSocketServerConfig } from '@anupheaus/nexus/server';
import type { CreateInviteOptions } from '@anupheaus/nexus/server';
import type { InviteDetails } from '@anupheaus/nexus/common';
import type { GoogleProfile } from '@anupheaus/nexus/common/auth';
import type { PromiseMaybe } from '@anupheaus/common';
import type Koa from 'koa';

export type AnyHttpServer = Http2Server | HttpServer | HttpsServer;

export { Koa };

export interface WebAuthnServerAuthConfig {
  mode: 'webauthn';
  /** WebAuthn relying party ID — the domain registered devices authenticate against.
   *  Defaults to `'localhost'` in development. */
  rpId?: string;
  onGetUserDetails?(userId: string): Promise<MXDBUser>;
  onGetInviteDetails?(userId: string, accountId?: string): Promise<InviteDetails>;
}

export interface GoogleOAuthServerAuthConfig {
  mode: 'google-oauth';
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  baseScopes: string[];
  capacitorCallbackUrl?: string;
  syncUserToClient?: boolean;
  onGetUserDetails?(userId: string): Promise<MXDBUser>;
  onCreateUser(profile: GoogleProfile): Promise<MXDBUser>;
}

export type ServerAuthConfig = WebAuthnServerAuthConfig | GoogleOAuthServerAuthConfig;

export interface ServerConfig extends StartSocketServerConfig {
  collections: MXDBCollection[];
  mongoDbUrl: string;
  mongoDbName: string;
  clearDatabase?: boolean;
  shouldSeedCollections?: boolean;
  changeStreamDebounceMs?: number;
  auth: ServerAuthConfig;
  onGetAccountDetails?(accountId: string): Promise<MXDBAccount | undefined>;
  onConnected?(ctx: { user: MXDBUser; account?: MXDBAccount }): PromiseMaybe<void>;
  onDisconnected?(ctx: {
    user: MXDBUser;
    account?: MXDBAccount;
    reason: 'signedOut' | 'connectionLost';
  }): PromiseMaybe<void>;
}

export interface ServerInstance {
  app: Koa;
  /** Only available when `auth.mode === 'webauthn'`. */
  createInvite?(options: CreateInviteOptions): Promise<string>;
  getDevices(userId: string): Promise<MXDBDeviceInfo[]>;
  enableDevice(requestId: string): Promise<void>;
  disableDevice(requestId: string): Promise<void>;
  close(): Promise<void>;
}
```

- [ ] **Step 2: Run full unit tests to check for type errors**

```
pnpm test:ci
```

Expected: tests pass; TypeScript compiler will catch call-sites that need updating in later tasks.

- [ ] **Step 3: Commit**

```
git add src/server/internalModels.ts
git commit -m "feat(auth): replace scattered auth fields with ServerConfig.auth discriminated union"
```

---

## Task 6: Update `startAuthenticatedServer.ts` — branch on auth mode

**Files:**
- Modify: `src/server/startAuthenticatedServer.ts`

- [ ] **Step 1: Update `startAuthenticatedServer.ts`**

Replace the entire file:

```ts
import type { ServerDb } from './providers';
import { setServerToClientSync } from './providers';
import { registerClientS2C, unregisterClientS2C } from './providers/db/clientS2CStore';
import { seedCollections } from './seeding';
import { internalActions } from './actions';
import {
  startServer as startSocketServer,
  useAction,
  useAuthentication as useSocketAuthentication,
} from '@anupheaus/nexus/server';
import { defineAuthentication } from '@anupheaus/nexus/server';
import { internalSubscriptions } from './subscriptions';
import { addClientWatches, removeClientWatches } from './clientDbWatches';
import { ServerToClientSynchronisation } from './ServerToClientSynchronisation';
import { WebAuthnAuthCollection } from './auth/WebAuthnAuthCollection';
import { GoogleOAuthAuthCollection } from './auth/GoogleOAuthAuthCollection';
import { registerDevAuthRoute } from './auth/registerDevAuthRoute';
import { mxdbServerToClientSyncAction } from '../common/internalActions';
import type { Socket } from 'socket.io';
import type { ServerAuthConfig, ServerConfig } from './internalModels';
import type { AuthCollection } from './auth/AuthCollection';
import type { SocketAPIAuthRecord } from '@anupheaus/nexus/common/auth';
import { Logger } from '@anupheaus/common';
import type { MXDBAccount, MXDBUser } from '../common/models';

const SESSION_COOKIE_NAME = 'socketapi_session';

const clientS2CInstances = new WeakMap<Socket, ServerToClientSynchronisation>();
const connectedUsers = new WeakMap<Socket, MXDBUser>();
const connectedAccounts = new WeakMap<Socket, MXDBAccount>();
const disconnectReasons = new WeakMap<Socket, string>();

const adminUser = { id: Math.emptyId() } as MXDBUser;

interface Props extends ServerConfig {
  db: ServerDb;
}

function parseSessionToken(client: Socket): string | undefined {
  const cookieHeader = client.handshake.headers.cookie as string | undefined;
  const fromCookie = cookieHeader
    ?.split(';')
    .map(s => s.trim())
    .find(s => s.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);
  const fromAuth = (client.handshake.auth as Record<string, unknown>)?.sessionToken as
    | string
    | undefined;
  return fromCookie ?? fromAuth;
}

function buildOnGetUser(authConfig: ServerAuthConfig) {
  return async (userId: string): Promise<MXDBUser | undefined> => {
    if (authConfig.onGetUserDetails == null) return { id: userId } as MXDBUser;
    try {
      return await authConfig.onGetUserDetails(userId);
    } catch {
      return undefined;
    }
  };
}

function createAuthCollection(
  auth: ServerAuthConfig,
  db: ServerDb,
): AuthCollection<SocketAPIAuthRecord> {
  if (auth.mode === 'webauthn') return new WebAuthnAuthCollection(db);
  return new GoogleOAuthAuthCollection(db);
}

export async function startAuthenticatedServer({
  db,
  shouldSeedCollections,
  collections,
  logger,
  actions,
  subscriptions,
  onClientConnected,
  onClientDisconnected,
  onConnected,
  onDisconnected,
  onGetAccountDetails,
  auth,
  changeStreamDebounceMs,
  ...config
}: Props) {
  const { configureAuthentication, useAuthentication } = defineAuthentication<
    MXDBUser,
    MXDBAccount
  >();
  const authColl = createAuthCollection(auth, db);

  const socketAuth =
    auth.mode === 'webauthn'
      ? configureAuthentication({
          mode: 'webauthn',
          store: authColl as WebAuthnAuthCollection,
          rpId: auth.rpId,
          onGetInviteDetails: async (userId, accountId) => {
            if (auth.onGetInviteDetails == null)
              throw new Error('onGetInviteDetails is required for WebAuthn servers');
            return auth.onGetInviteDetails(userId, accountId);
          },
          onGetUser: buildOnGetUser(auth),
        })
      : configureAuthentication({
          mode: 'google-oauth',
          store: authColl as GoogleOAuthAuthCollection,
          clientId: auth.clientId,
          clientSecret: auth.clientSecret,
          redirectUri: auth.redirectUri,
          baseScopes: auth.baseScopes,
          capacitorCallbackUrl: auth.capacitorCallbackUrl,
          syncUserToClient: auth.syncUserToClient ?? false,
          onGetUser: buildOnGetUser(auth),
          onCreateUser: auth.onCreateUser,
        });

  logger?.info('[startAuthenticatedServer] calling startSocketServer');
  const { app } = await startSocketServer({
    ...config,
    logger,
    actions: [...internalActions, ...(actions ?? [])],
    subscriptions: [...internalSubscriptions, ...(subscriptions ?? [])],
    auth: socketAuth,

    async onStartup() {
      logger?.info('[startAuthenticatedServer] onStartup.begin');
      const { impersonateUser } = useAuthentication();
      await impersonateUser(adminUser, async () => {
        const startupLogger = (
          logger ?? Logger.getCurrent() ?? new Logger('mxdb-sync')
        ).createSubLogger('s2c:startup');
        setServerToClientSync(
          ServerToClientSynchronisation.createNoOp(collections, startupLogger),
        );
        const startTime = Date.now();
        if (shouldSeedCollections === true) await seedCollections(collections);
        startupLogger.info(`Seeding took ${Date.now() - startTime}ms`);
        if (config.onStartup != null) await config.onStartup();
      });
      logger?.info('[startAuthenticatedServer] onStartup.done');
    },

    onRegisterRoutes: async router => {
      if (process.env.NODE_ENV !== 'production') {
        registerDevAuthRoute(router, config.name, authColl, auth.mode);
      }
      await config.onRegisterRoutes?.(router);
    },

    onClientConnected: async (client: Socket) => {
      client.once('disconnect', (reason: string) => disconnectReasons.set(client, reason));
      const socketAuth = useSocketAuthentication<MXDBUser, MXDBAccount>();

      if (socketAuth.user != null) {
        if (socketAuth.account == null && onGetAccountDetails != null) {
          const sessionToken = parseSessionToken(client);
          if (sessionToken != null) {
            const record = await authColl.findBySessionToken(sessionToken);
            if (record?.accountId != null) {
              const resolvedAccount = await onGetAccountDetails(record.accountId).catch(
                () => undefined,
              );
              if (resolvedAccount != null) await socketAuth.setAccount(resolvedAccount);
            }
          }
        }
        await socketAuth.setUser(socketAuth.user);
        connectedUsers.set(client, socketAuth.user);
        const currentAccount = socketAuth.account;
        if (currentAccount != null) connectedAccounts.set(client, currentAccount);
        await onConnected?.({ user: socketAuth.user, account: currentAccount });
      }

      const s2cLogger = (
        logger ?? Logger.getCurrent() ?? new Logger('mxdb-sync')
      ).createSubLogger(`s2c:${client.id}`);
      const emitS2C = useAction(mxdbServerToClientSyncAction);
      const s2c = new ServerToClientSynchronisation({
        emitS2C: async payload => emitS2C(payload),
        getDb: () => db,
        collections,
        logger: s2cLogger,
      });
      clientS2CInstances.set(client, s2c);
      registerClientS2C(client, s2c);
      setServerToClientSync(s2c);
      addClientWatches(client, collections, s2c);
      await onClientConnected?.(client);
    },

    onClientDisconnected: async client => {
      removeClientWatches(client);
      unregisterClientS2C(client);

      const s2c = clientS2CInstances.get(client);
      if (s2c != null) {
        s2c.close();
        clientS2CInstances.delete(client);
      }

      const user = connectedUsers.get(client);
      const account = connectedAccounts.get(client);
      connectedUsers.delete(client);
      connectedAccounts.delete(client);

      if (user != null) {
        const rawReason = disconnectReasons.get(client) ?? '';
        const reason =
          rawReason === 'server namespace disconnect' ? 'signedOut' : 'connectionLost';
        disconnectReasons.delete(client);
        await onDisconnected?.({ user, account, reason });
      }

      await onClientDisconnected?.(client);
    },
  });

  logger?.info('[startAuthenticatedServer] done');
  return { app, authColl };
}
```

- [ ] **Step 2: Run full unit tests**

```
pnpm test:ci
```

Expected: TypeScript may report errors in `startServer.ts` and `registerDevAuthRoute.ts` (next tasks). Auth-collection unit tests still pass.

- [ ] **Step 3: Commit**

```
git add src/server/startAuthenticatedServer.ts
git commit -m "feat(auth): branch startAuthenticatedServer on auth.mode; instantiate correct collection subclass"
```

---

## Task 7: Update `registerDevAuthRoute.ts` — accept collection + mode

**Files:**
- Modify: `src/server/auth/registerDevAuthRoute.ts`

- [ ] **Step 1: Update `registerDevAuthRoute.ts`**

Replace the entire file:

```ts
import crypto from 'crypto';
import type Router from 'koa-router';
import type { WebAuthnAuthRecord, GoogleOAuthAuthRecord } from '@anupheaus/nexus/common/auth';
import type { AuthCollection } from './AuthCollection';
import type { SocketAPIAuthRecord } from '@anupheaus/nexus/common/auth';
import type { ServerAuthConfig } from '../internalModels';

const COOKIE_NAME = 'socketapi_session';
const DEV_SESSION_TOKEN_PREFIX = 'dev-bypass-';

function buildSetCookieHeader(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export function registerDevAuthRoute(
  router: Router,
  name: string,
  authColl: AuthCollection<SocketAPIAuthRecord>,
  mode: ServerAuthConfig['mode'],
): void {
  router.post(`/${name}/dev/signin`, async ctx => {
    const body = ctx.request.body as Record<string, unknown>;
    const userId = body?.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
      ctx.status = 400;
      return;
    }
    const requestId = `dev-bypass-${userId}`;
    const sessionToken = `${DEV_SESSION_TOKEN_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
    const existing = await authColl.findById(requestId);

    if (existing != null) {
      await authColl.update(requestId, { sessionToken, isEnabled: true });
    } else if (mode === 'webauthn') {
      await authColl.create({
        requestId,
        userId,
        sessionToken,
        deviceId: 'dev-bypass',
        isEnabled: true,
        deviceDetails: undefined,
      } as WebAuthnAuthRecord);
    } else {
      await authColl.create({
        requestId,
        userId,
        sessionToken,
        deviceId: 'dev-bypass',
        isEnabled: true,
        deviceDetails: undefined,
        googleAccessToken: '',
        googleRefreshToken: '',
        googleTokenExpiresAt: 0,
        grantedScopes: [],
      } as GoogleOAuthAuthRecord);
    }

    ctx.set('Set-Cookie', buildSetCookieHeader(sessionToken));
    ctx.status = 200;
    ctx.body = { ok: true, userId, sessionToken };
  });
}
```

- [ ] **Step 2: Run full unit tests**

```
pnpm test:ci
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add src/server/auth/registerDevAuthRoute.ts
git commit -m "feat(auth): registerDevAuthRoute accepts authColl + mode; creates correct record type per mode"
```

---

## Task 8: Update `deviceManagement.ts` — accept `AuthCollection` instead of `ServerDb`

**Files:**
- Modify: `src/server/auth/deviceManagement.ts`

- [ ] **Step 1: Update `deviceManagement.ts`**

Replace the entire file:

```ts
import type { SocketAPIAuthRecord } from '@anupheaus/nexus/common/auth';
import type { AuthCollection } from './AuthCollection';
import type { MXDBDeviceInfo } from '../../common/models';

export async function getDevices(
  authColl: AuthCollection<SocketAPIAuthRecord>,
  userId: string,
): Promise<MXDBDeviceInfo[]> {
  const records = await authColl.findAllByUserId(userId);
  return records.map((r: SocketAPIAuthRecord) => ({
    requestId: r.requestId,
    userId: r.userId,
    deviceDetails: r.deviceDetails,
    isEnabled: r.isEnabled,
    lastConnectedAt: r.lastConnectedAt,
  }));
}

export async function enableDevice(
  authColl: AuthCollection<SocketAPIAuthRecord>,
  requestId: string,
): Promise<void> {
  await authColl.update(requestId, { isEnabled: true });
}

export async function disableDevice(
  authColl: AuthCollection<SocketAPIAuthRecord>,
  requestId: string,
): Promise<void> {
  await authColl.update(requestId, { isEnabled: false });
}
```

- [ ] **Step 2: Run full unit tests**

```
pnpm test:ci
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add src/server/auth/deviceManagement.ts
git commit -m "refactor(auth): deviceManagement accepts AuthCollection directly; removes duplicate collection instantiation"
```

---

## Task 9: Update `startServer.ts` — wire authColl to device management; remove duplicate dev-route call

**Files:**
- Modify: `src/server/startServer.ts`

- [ ] **Step 1: Update `startServer.ts`**

Replace the entire file:

```ts
import { provideDb } from './providers';
import { Logger } from '@anupheaus/common';
import { startAuthenticatedServer } from './startAuthenticatedServer';
import { getDevices, enableDevice, disableDevice } from './auth/deviceManagement';
import { useAuthentication } from '@anupheaus/nexus/server';
import type { ServerConfig, ServerInstance } from './internalModels';

/**
 * Initialises the MXDB-sync server: connects to MongoDB, starts Socket.IO, registers auth,
 * wires actions/subscriptions, and optionally seeds collections.
 *
 * @param config - Server configuration. `config.auth.mode` selects the authentication strategy:
 *   - `'webauthn'` — passkey-based multi-device auth; exposes `createInvite` on the returned instance.
 *   - `'google-oauth'` — Google OAuth 2.0; no invite flow.
 */
export async function startServer(config: ServerConfig): Promise<ServerInstance> {
  let { logger, name, collections, mongoDbName, mongoDbUrl, changeStreamDebounceMs } = config;
  if (!logger) logger = Logger.getCurrent();
  if (!logger) logger = new Logger('MXDB-Sync');

  logger.info('[startServer] begin', { name, mongoDbName, collectionCount: collections.length });

  return logger.provide(() =>
    provideDb(mongoDbName, mongoDbUrl, collections, async db => {
      logger!.info('[startServer] provideDb — waiting for Mongo');
      await db.getMongoDb();
      logger!.info('[startServer] Mongo connected');

      const { app, authColl } = await startAuthenticatedServer({ ...config, db, logger });

      if (app == null) throw new Error('Failed to start server');

      const instance: ServerInstance = {
        app,
        getDevices: async (userId: string) => getDevices(authColl, userId),
        enableDevice: async (requestId: string) => enableDevice(authColl, requestId),
        disableDevice: async (requestId: string) => disableDevice(authColl, requestId),
        close: async () => db.close(),
      };

      if (config.auth.mode === 'webauthn') {
        instance.createInvite = async options => useAuthentication().createInvite(options);
      }

      return instance;
    }, changeStreamDebounceMs),
  );
}
```

- [ ] **Step 2: Run full unit tests**

```
pnpm test:ci
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add src/server/startServer.ts
git commit -m "refactor(server): wire authColl from startAuthenticatedServer to device management; createInvite only in webauthn mode"
```

---

## Task 10: Update client `MXDBSync.tsx` — add `authMode` prop

**Files:**
- Modify: `src/client/MXDBSync.tsx`

- [ ] **Step 1: Update `MXDBSync.tsx`**

Replace the entire file:

```tsx
import { createComponent, useBound } from '@anupheaus/react-ui';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import type { Logger } from '@anupheaus/common';
import { LoggerProvider } from '@anupheaus/react-ui';
import type { SocketAPIUser } from '@anupheaus/nexus/client';
import { SocketAPI } from '@anupheaus/nexus/client';
import { ConflictResolutionContext } from './providers';
import { MXDBSyncInner } from './auth/MXDBSyncInner';
import { setupBrowserTools } from './utils/setupBrowserTools';
import type { MXDBCollection, MXDBError } from '../common';
import type { MXDBUser } from '../common/models';

interface Props {
  host?: string;
  name: string;
  logger?: Logger;
  autoConnect?: boolean;
  collections: MXDBCollection[];
  /** Defaults to `'webauthn'`. Set to `'google-oauth'` when the server is configured for Google OAuth. */
  authMode?: 'webauthn' | 'google-oauth';
  onDeviceDisabled?(): void;
  onSignedIn?(user: MXDBUser): void;
  onSignedOut?(): void;
  onError?(error: MXDBError): void;
  onConflictResolution?(message: string): Promise<boolean>;
  children?: ReactNode;
}

export const MXDBSync = createComponent('MXDBSync', ({
  host,
  name,
  logger,
  autoConnect,
  collections,
  authMode = 'webauthn',
  onDeviceDisabled,
  onSignedIn,
  onSignedOut,
  onError,
  onConflictResolution,
  children,
}: Props) => {
  if (host != null) {
    const protocol = host.match(/^([a-z][a-z0-9+\-.]*:\/\/)/i)?.[1]?.toLowerCase();
    if (protocol != null && protocol !== 'wss://') {
      throw new Error(`MXDBSync: connection to "${host}" uses an insecure protocol. Only wss:// is allowed.`);
    }
  }

  useEffect(() => { setupBrowserTools(name); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const conflictResolutionContext = useMemo(() => ({ onConflictResolution }), [onConflictResolution]);

  const onPrfRef = useRef<
    ((userId: string, prfOutput: ArrayBuffer, accountId?: string) => void | Promise<void>) | undefined
  >(undefined);

  const handlePrf = useBound(
    (userId: string, prfOutput: ArrayBuffer, accountId?: string) =>
      onPrfRef.current?.(userId, prfOutput, accountId) ?? undefined,
  );
  const handleSignedIn = useBound((user: SocketAPIUser) => onSignedIn?.(user as MXDBUser));

  return (
    <LoggerProvider logger={logger} loggerName="MXDB-Sync">
      <ConflictResolutionContext.Provider value={conflictResolutionContext}>
        <SocketAPI
          name={name}
          host={host}
          autoConnect={autoConnect}
          onPrf={authMode === 'webauthn' ? handlePrf : undefined}
          onDeviceDisabled={onDeviceDisabled}
          onSignedIn={onSignedIn != null ? handleSignedIn : undefined}
          onSignedOut={onSignedOut}
        >
          <MXDBSyncInner
            appName={name}
            authMode={authMode}
            collections={collections}
            onPrfRef={onPrfRef}
            onError={onError}
            onSignedIn={onSignedIn}
            onSignedOut={onSignedOut}
          >
            {children}
          </MXDBSyncInner>
        </SocketAPI>
      </ConflictResolutionContext.Provider>
    </LoggerProvider>
  );
});
```

- [ ] **Step 2: Run full unit tests**

```
pnpm test:ci
```

Expected: TypeScript error in `MXDBSyncInner` (missing `authMode` prop) — fixed in next task.

- [ ] **Step 3: Commit (after next task fixes the TS error)**

Hold this commit until Task 11 resolves the TypeScript error.

---

## Task 11: Update `MXDBSyncInner.tsx` — mount immediately for Google OAuth

**Files:**
- Modify: `src/client/auth/MXDBSyncInner.tsx`

- [ ] **Step 1: Update `MXDBSyncInner.tsx`**

Replace the entire file:

```tsx
import { createComponent, useLogger } from '@anupheaus/react-ui';
import type { ReactNode, MutableRefObject } from 'react';
import { useState, useEffect, useRef } from 'react';
import { useAuthentication } from '@anupheaus/nexus/client';
import { DbsProvider } from '../providers/dbs';
import { ClientToServerSyncProvider, ClientToServerProvider } from '../providers/client-to-server';
import { ServerToClientProvider } from '../providers/server-to-client';
import { deriveKey } from './deriveKey';
import type { MXDBCollection, MXDBError } from '../../common';
import type { MXDBAccount, MXDBUser } from '../../common/models';

interface Props {
  appName: string;
  authMode: 'webauthn' | 'google-oauth';
  collections: MXDBCollection[];
  onPrfRef: MutableRefObject<
    ((userId: string, prfOutput: ArrayBuffer, accountId?: string) => void | Promise<void>) | undefined
  >;
  onError?(error: MXDBError): void;
  onSignedIn?(user: MXDBUser): void;
  onSignedOut?(): void;
  children?: ReactNode;
}

// Google OAuth has no hardware-backed PRF, so local data is not encrypted at rest.
// All bytes are zero to distinguish this from the dev-bypass key (0xde pattern).
const GOOGLE_OAUTH_PLACEHOLDER_KEY = new Uint8Array(32).fill(0);

export const MXDBSyncInner = createComponent('MXDBSyncInner', ({
  appName,
  authMode,
  collections,
  onPrfRef,
  onError,
  onSignedIn,
  onSignedOut,
  children,
}: Props) => {
  const logger = useLogger('MXDBSyncInner');
  const { user } = useAuthentication<MXDBUser, MXDBAccount>();
  const [encryptionKey, setEncryptionKey] = useState<Uint8Array | undefined>();
  const [dbName, setDbName] = useState<string | undefined>();
  const channelRef = useRef<BroadcastChannel | null>(null);
  const prevUserRef = useRef<MXDBUser | undefined>(undefined);
  const reauthInProgressRef = useRef(false);

  // Dev bypass (non-production only)
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const devJson =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(`mxdb:dev-auth:${appName}`)
        : null;
    if (devJson == null) return;
    try {
      const { userId } = JSON.parse(devJson) as { userId: string };
      logger.info('[dev] dev bypass auth');
      localStorage.removeItem(`mxdb:dev-auth:${appName}`);
      setDbName(userId);
      setEncryptionKey(new Uint8Array(32).fill(0xde));
    } catch {
      localStorage.removeItem(`mxdb:dev-auth:${appName}`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // BroadcastChannel: cross-tab sign-out
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(`mxdb-auth-${appName}`);
    channelRef.current = channel;
    channel.onmessage = ({ data }: MessageEvent<{ type: string }>) => {
      if (data?.type === 'signed-out') {
        setEncryptionKey(undefined);
        setDbName(undefined);
      }
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [appName]);

  // WebAuthn only: wire the PRF handler — called by socket-api after the ceremony completes
  useEffect(() => {
    if (authMode !== 'webauthn') return;
    onPrfRef.current = async (userId: string, prfOutput: ArrayBuffer, accountId?: string) => {
      try {
        const key = await deriveKey(prfOutput);
        setEncryptionKey(key);
        setDbName(accountId ?? userId);
        reauthInProgressRef.current = false;
      } catch (err) {
        reauthInProgressRef.current = false;
        onError?.({
          code: 'ENCRYPTION_FAILED',
          message: err instanceof Error ? err.message : 'Key derivation failed',
          severity: 'fatal',
          originalError: err,
        });
      }
    };
    return () => {
      onPrfRef.current = undefined;
    };
  }, [authMode, onPrfRef, onError]);

  // React to user state changes
  useEffect(() => {
    const prev = prevUserRef.current;
    prevUserRef.current = user;

    if (user == null && prev != null) {
      setEncryptionKey(undefined);
      setDbName(undefined);
      channelRef.current?.postMessage({ type: 'signed-out' });
      onSignedOut?.();
      return;
    }

    if (user != null && prev == null) {
      onSignedIn?.(user);
      // Google OAuth: no PRF ceremony — mount DbsProvider immediately on sign-in
      if (authMode === 'google-oauth') {
        setDbName(user.id);
        setEncryptionKey(GOOGLE_OAUTH_PLACEHOLDER_KEY);
      }
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  if (encryptionKey == null || dbName == null) {
    return <>{children}</>;
  }

  return (
    <DbsProvider name={dbName} encryptionKey={encryptionKey} collections={collections} logger={logger}>
      <ClientToServerSyncProvider collections={collections} onError={onError}>
        <ClientToServerProvider />
        <ServerToClientProvider />
        {children}
      </ClientToServerSyncProvider>
    </DbsProvider>
  );
});
```

- [ ] **Step 2: Run full unit tests**

```
pnpm test:ci
```

Expected: PASS — no TypeScript errors.

- [ ] **Step 3: Commit Tasks 10 and 11 together**

```
git add src/client/MXDBSync.tsx src/client/auth/MXDBSyncInner.tsx
git commit -m "feat(client): add authMode prop; MXDBSyncInner mounts DbsProvider immediately for google-oauth"
```

---

## Task 12: Update test app `test/server/start.ts`

**Files:**
- Modify: `test/server/start.ts`
- Modify: `test/server/configureAuth.ts`

- [ ] **Step 1: Update `test/server/start.ts`**

Replace the `startServer` call block (lines 36–49) with the new `auth` shape:

```ts
const { app, createInvite } = await startServer({
  name: 'mxdb-sync-test',
  logger,
  collections,
  actions,
  server,
  mongoDbName,
  mongoDbUrl,
  clientLoggingService: () => loggerService,
  auth: {
    mode: 'webauthn',
    onGetUserDetails: async (userId) => ({ id: userId }),
  },
});
```

- [ ] **Step 2: Update `test/server/configureAuth.ts`**

`createInvite` is now optional on `ServerInstance`. Update the call to guard against it being undefined:

```ts
import Router from 'koa-router';
import type Koa from 'koa';
import type { CreateInviteOptions } from '@anupheaus/nexus/server';

const TEST_USER_ID = 'test-user-1';

export function configureAuth(
  app: Koa,
  createInvite: ((options: CreateInviteOptions) => Promise<string>) | undefined,
): void {
  if (createInvite == null) return;
  const router = new Router();

  router.get('/api/create-invite', async ctx => {
    const url = await createInvite({ userId: TEST_USER_ID, baseUrl: `http://${ctx.host}` });
    ctx.body = { url };
  });

  app.use(router.routes());
  app.use(router.allowedMethods());
}
```

- [ ] **Step 3: Run full unit tests**

```
pnpm test:ci
```

Expected: PASS.

- [ ] **Step 4: Commit**

```
git add test/server/start.ts test/server/configureAuth.ts
git commit -m "chore(test): update test app to new auth discriminated union config shape"
```

---

## Self-Review

**Spec coverage:**
- ✅ `AuthCollection` is now abstract generic base — Task 1
- ✅ `WebAuthnAuthCollection` subclass with `findByRegistrationToken`, `findByKeyHash`, array `findByUserId` — Task 2
- ✅ `GoogleOAuthAuthCollection` subclass with singular `findByUserId` — Task 3
- ✅ `ServerConfig.auth` is a `WebAuthnServerAuthConfig | GoogleOAuthServerAuthConfig` discriminated union — Task 5
- ✅ `startAuthenticatedServer` branches on `auth.mode` — Task 6
- ✅ `registerDevAuthRoute` creates the correct record type per mode — Task 7
- ✅ `deviceManagement` uses `findAllByUserId` from base class — Task 8
- ✅ `startServer` wires `authColl` to device management; `createInvite` is WebAuthn-only — Task 9
- ✅ Client `MXDBSync` conditionally passes `onPrf` — Task 10
- ✅ Client `MXDBSyncInner` mounts immediately for Google OAuth — Task 11
- ✅ Test app updated to new config shape — Task 12

**Placeholder scan:** No TBD/TODO/similar found.

**Type consistency:**
- `AuthCollection<TRecord>` used consistently across Tasks 1, 6, 7, 8
- `findAllByUserId` (base class helper) vs `findByUserId` (store interface method) clearly named throughout
- `ServerAuthConfig['mode']` used in Task 7 to ensure the mode discriminator is typed correctly
