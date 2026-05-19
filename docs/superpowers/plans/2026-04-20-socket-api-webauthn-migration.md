# socket-api WebAuthn Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate mxdb-sync's auth layer to delegate all WebAuthn ceremonies, session management, and cookie handling to socket-api, retaining only encryption key derivation, OPFS database lifecycle, and cross-tab coordination.

**Architecture:** socket-api owns WebAuthn (registration/reauth via `signIn()`), cookie-based sessions (`socketapi_session`), and user propagation. mxdb-sync adds an `onPrf` callback to derive an AES-GCM encryption key from the PRF output, manages the OPFS db lifecycle in a new `MXDBSyncInner` component, and re-exports socket-api's `useAuthentication` for consumers. Server-side token rotation is removed entirely; `defineAuthentication` + `WebAuthnAuthStore` replace the old `AuthCollection`/`TokenRotation` machinery.

**Tech Stack:** React (`createComponent` from `@anupheaus/react-ui`), socket-api (`SocketAPI`, `useAuthentication` client hook, `defineAuthentication` + `ServerUseAuthResult` server side, `WebAuthnAuthStore`/`WebAuthnAuthRecord` from `@anupheaus/nexus/common`), MongoDB (`AuthCollection`), OPFS/SQLite, vitest.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/client/useMXDBSync.ts` | Modify | Rename testDisconnect/testReconnect |
| `tests/e2e/setup/syncClient.tsx` | Modify | Update call sites of renamed hook fields |
| `src/common/models/authModels.ts` | Modify | Replace MXDBAuthRecord with WebAuthnAuthRecord-compatible shape |
| `src/server/auth/AuthCollection.ts` | Rewrite | Implement WebAuthnAuthStore interface |
| `src/client/auth/deriveKey.ts` | Create | HKDF derivation extracted from old deriveEncryptionKey.ts |
| `src/common/internalEvents.ts` | Modify | Remove mxdbTokenRotated, mxdbDeviceBlocked, mxdbUserAuthenticated |
| `src/common/internalActions.ts` | Modify | Remove mxdbSignOutAction |
| `src/server/auth/useAuth.ts` | Rewrite | Delegate to socket-api's useAuthentication |
| `src/server/internalModels.ts` | Modify | Remove inviteLinkTTLMs; remove deviceInfo from callbacks |
| `src/server/auth/registerDevAuthRoute.ts` | Create | Non-production dev auth cookie route |
| `src/server/startAuthenticatedServer.ts` | Rewrite | Use defineAuthentication; remove token rotation |
| `src/server/startServer.ts` | Rewrite | Remove registerAuthInviteRoute; surface createInvite |
| `src/server/index.ts` | Modify | Remove MXDBAuthRecord; keep MXDBDeviceInfo for getDevices |
| `src/client/auth/MXDBSyncInner.tsx` | Create | Lifecycle: reauth trigger, key state, BroadcastChannel, DbsProvider |
| `src/client/MXDBSync.tsx` | Rewrite | SocketAPI + MXDBSyncInner hierarchy; updated props |
| `src/client/hooks/useAuth.ts` | Rewrite | Wrap socket-api useAuthentication |
| `src/client/hooks/useMXDBSignOut.ts` | Rewrite | Use socket-api signOut |
| `src/client/hooks/useMXDBUserId.ts` | Rewrite | Use socket-api user |
| `src/client/hooks/useMXDBInvite.ts` | Delete | Invite now automatic via signIn() + ?requestId= |
| `src/client/hooks/index.ts` | Modify | Remove useMXDBInvite export |
| `src/client/utils/setupBrowserTools.ts` | Modify | setDevAuth calls /dev/signin; stores only userId |
| `src/client/index.ts` | Modify | Re-export useAuthentication; remove mxdbDeviceBlocked |
| `src/client/auth/AuthProvider.tsx` | Delete | Replaced by MXDBSyncInner |
| `src/client/auth/TokenProvider.tsx` | Delete | Replaced by HttpOnly cookie |
| `src/client/auth/SocketProvider.tsx` | Delete | Replaced by SocketAPI with callbacks |
| `src/client/auth/IndexedDbProvider.tsx` | Delete | Credential ID store eliminated |
| `src/client/auth/IndexedDbContext.ts` | Delete | Same |
| `src/client/auth/IndexedDbAuthStore.ts` | Delete | Same |
| `src/client/auth/AuthContext.ts` | Delete | Re-exported useAuthentication replaces this |
| `src/client/auth/UserIdContext.ts` | Delete | User now from socket-api useAuthentication |
| `src/client/auth/deriveEncryptionKey.ts` | Delete | Replaced by deriveKey.ts |
| `src/server/auth/registerAuthInviteRoute.ts` | Delete | Replaced by socket-api /webauthn/invite + /register routes |
| `src/server/auth/TokenRotation.ts` | Delete | Token rotation removed |
| `src/server/auth/authConfig.ts` | Delete | Replaced by defineAuthentication config |
| `src/client/auth/AuthContext.tests.ts` | Delete | Tests for deleted file |
| `src/client/auth/IndexedDbAuthStore.tests.ts` | Delete | Tests for deleted file |
| `src/client/auth/IndexedDbContext.tests.ts` | Delete | Tests for deleted file |
| `src/client/auth/hooks.tests.tsx` | Delete | Tests for deleted auth hooks |

---

## Task 1: Rename testDisconnect / testReconnect

**Files:**
- Modify: `src/client/useMXDBSync.ts`
- Modify: `tests/e2e/setup/syncClient.tsx`

- [ ] **Step 1: Edit useMXDBSync.ts — rename the returned fields**

Replace:
```ts
const { getIsConnected, onConnectionStateChanged, getSocket, testDisconnect, testReconnect } = useSocketAPI();
```
with:
```ts
const { getIsConnected, onConnectionStateChanged, getSocket, disconnect, connect } = useSocketAPI();
```

Replace the return object:
```ts
  return {
    get isSynchronising() { ... },
    get isConnected() { ... },
    get clientId() { ... },
    onConnectionStateChanged,
    disconnect,
    connect,
  };
```

- [ ] **Step 2: Update syncClient.tsx — update the two call sites**

In `SyncClientDriverInner`, change the destructure:
```ts
const { disconnect, connect, isSynchronising } = useMXDBSync();
```

Change the two method bodies in `useImperativeHandle`:
```ts
async disconnect() {
  disconnect();
  await waitUntilAsync(async () => !getIsConnected(), 'Client disconnected', 30_000);
},
async reconnect() {
  connect();
  await waitUntilAsync(async () => getIsConnected(), 'Client reconnected', 30_000);
},
```

Update the dependency array at the bottom of `useImperativeHandle`:
```ts
[get, getAll, query, distinct, upsert, collectionRemove, disconnect, connect, getIsConnected, isSynchronising, c2sInstance, db]
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors related to testDisconnect / testReconnect.

- [ ] **Step 4: Commit**

```bash
git add src/client/useMXDBSync.ts tests/e2e/setup/syncClient.tsx
git commit -m "refactor: rename testDisconnect/testReconnect to disconnect/connect"
```

---

## Task 2: Update MXDBAuthRecord to be WebAuthnAuthRecord-compatible

**Files:**
- Modify: `src/common/models/authModels.ts`

The old record had `currentToken`/`pendingToken` (two-phase rotation). The new shape implements socket-api's `WebAuthnAuthRecord` interface: single `sessionToken` + `deviceId`.

- [ ] **Step 1: Rewrite authModels.ts**

```ts
// src/common/models/authModels.ts
import type { Record } from '@anupheaus/common';

export interface MXDBUserDetails extends Record {
  name: string;
  displayName?: string;
  [key: string]: unknown;
}

/**
 * MongoDB `mxdb_authentication` document — one row per registered device.
 * Shape matches socket-api's WebAuthnAuthRecord so AuthCollection can implement
 * WebAuthnAuthStore without an adapter layer.
 */
export interface MXDBAuthRecord {
  requestId: string;
  userId: string;
  /** Set by socket-api after WebAuthn registration completes. Empty string on invite records. */
  sessionToken: string;
  /** Deterministic device fingerprint ID computed by socket-api client. Empty on invite records. */
  deviceId: string;
  deviceDetails?: unknown;
  keyHash?: string;
  isEnabled: boolean;
  registrationToken?: string;
  lastConnectedAt?: number;
}

export interface MXDBDeviceInfo {
  requestId: string;
  userId: string;
  deviceDetails?: unknown;
  isEnabled: boolean;
  lastConnectedAt?: number;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: errors only in files that reference removed fields (`currentToken`, `pendingToken`, old model types) — those are addressed in later tasks.

- [ ] **Step 3: Commit**

```bash
git add src/common/models/authModels.ts
git commit -m "refactor(auth): replace token rotation fields with sessionToken/deviceId in MXDBAuthRecord"
```

---

## Task 3: Rewrite AuthCollection to implement WebAuthnAuthStore

**Files:**
- Rewrite: `src/server/auth/AuthCollection.ts`

`WebAuthnAuthStore` (from `@anupheaus/nexus/common`) requires: `create`, `findById`, `findBySessionToken`, `findByDevice`, `update`, `findByRegistrationToken`, `findByKeyHash`.

- [ ] **Step 1: Rewrite AuthCollection.ts**

```ts
// src/server/auth/AuthCollection.ts
import type { Collection } from 'mongodb';
import type { WebAuthnAuthRecord, WebAuthnAuthStore } from '@anupheaus/nexus/common';
import type { ServerDb } from '../providers';

const COLLECTION_NAME = 'mxdb_authentication';

type AuthDoc = Omit<WebAuthnAuthRecord, 'requestId'> & { _id: string };

function toDoc(record: WebAuthnAuthRecord): AuthDoc {
  const { requestId, ...rest } = record;
  return { _id: requestId, ...rest };
}

function fromDoc(doc: AuthDoc): WebAuthnAuthRecord {
  const { _id, ...rest } = doc;
  return { requestId: _id, ...rest };
}

export class AuthCollection implements WebAuthnAuthStore {
  constructor(db: ServerDb) {
    this.#coll = this.#init(db);
  }

  #coll: Promise<Collection<AuthDoc>>;

  async #init(serverDb: ServerDb): Promise<Collection<AuthDoc>> {
    const db = await serverDb.getMongoDb();
    const names = await db.listCollections({ name: COLLECTION_NAME }).toArray();
    if (names.length === 0) {
      const coll = await db.createCollection<AuthDoc>(COLLECTION_NAME);
      await coll.createIndex({ userId: 1 });
      await coll.createIndex({ sessionToken: 1 }, { sparse: true });
      await coll.createIndex({ deviceId: 1 }, { sparse: true });
      await coll.createIndex({ keyHash: 1 }, { sparse: true });
      return coll;
    }
    return db.collection<AuthDoc>(COLLECTION_NAME);
  }

  async create(record: WebAuthnAuthRecord): Promise<void> {
    const coll = await this.#coll;
    await coll.insertOne(toDoc(record));
  }

  async findById(requestId: string): Promise<WebAuthnAuthRecord | undefined> {
    const coll = await this.#coll;
    const doc = await coll.findOne({ _id: requestId } as any);
    return doc ? fromDoc(doc) : undefined;
  }

  async findBySessionToken(token: string): Promise<WebAuthnAuthRecord | undefined> {
    const coll = await this.#coll;
    const doc = await coll.findOne({ sessionToken: token } as any);
    return doc ? fromDoc(doc) : undefined;
  }

  async findByDevice(userId: string, deviceId: string): Promise<WebAuthnAuthRecord | undefined> {
    const coll = await this.#coll;
    const doc = await coll.findOne({ userId, deviceId } as any);
    return doc ? fromDoc(doc) : undefined;
  }

  async findByRegistrationToken(registrationToken: string): Promise<WebAuthnAuthRecord | undefined> {
    const coll = await this.#coll;
    const doc = await coll.findOne({ registrationToken } as any);
    return doc ? fromDoc(doc) : undefined;
  }

  async findByKeyHash(keyHash: string): Promise<WebAuthnAuthRecord | undefined> {
    const coll = await this.#coll;
    const doc = await coll.findOne({ keyHash } as any);
    return doc ? fromDoc(doc) : undefined;
  }

  async findByUserId(userId: string): Promise<WebAuthnAuthRecord[]> {
    const coll = await this.#coll;
    const docs = await coll.find({ userId } as any).toArray();
    return docs.map(fromDoc);
  }

  async update(requestId: string, patch: Partial<WebAuthnAuthRecord>): Promise<void> {
    const coll = await this.#coll;
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

- [ ] **Step 2: Update deviceManagement.ts — remove createDevToken, update createInviteLink**

Open `src/server/auth/deviceManagement.ts`. Replace `createDevToken` removal and update `createInviteLink` to use `WebAuthnAuthRecord`:

```ts
import type { WebAuthnAuthRecord } from '@anupheaus/nexus/common';
// Remove DEV_BYPASS_KEY_HASH and createDevToken entirely.
// createInviteLink is also removed — invite is now created by socket-api's createInvite().

export async function getDevices(db: ServerDb, userId: string): Promise<MXDBDeviceInfo[]> {
  const authColl = new AuthCollection(db);
  const records = await authColl.findByUserId(userId);
  return records.map((r: WebAuthnAuthRecord) => ({
    requestId: r.requestId,
    userId: r.userId,
    deviceDetails: r.deviceDetails,
    isEnabled: r.isEnabled,
    lastConnectedAt: r.lastConnectedAt,
  }));
}

export async function enableDevice(db: ServerDb, requestId: string): Promise<void> {
  const authColl = new AuthCollection(db);
  await authColl.update(requestId, { isEnabled: true });
}

export async function disableDevice(db: ServerDb, requestId: string): Promise<void> {
  const authColl = new AuthCollection(db);
  await authColl.update(requestId, { isEnabled: false });
}
```

- [ ] **Step 3: Verify TypeScript compiles (auth layer)**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: errors only in files that haven't been updated yet (startServer, startAuthenticatedServer, etc.).

- [ ] **Step 4: Commit**

```bash
git add src/server/auth/AuthCollection.ts src/server/auth/deviceManagement.ts
git commit -m "refactor(auth): rewrite AuthCollection to implement WebAuthnAuthStore"
```

---

## Task 4: Add deriveKey.ts

**Files:**
- Create: `src/client/auth/deriveKey.ts`
- Create: `src/client/auth/deriveKey.tests.ts`

Extracts the HKDF logic from the old `deriveEncryptionKey.ts` into a standalone pure function. Keeps the same salt so existing encrypted OPFS databases remain readable.

- [ ] **Step 1: Write the failing test**

Create `src/client/auth/deriveKey.tests.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { deriveKey } from './deriveKey';

describe('deriveKey', () => {
  it('returns a 32-byte Uint8Array from an ArrayBuffer', async () => {
    const prfOutput = crypto.getRandomValues(new Uint8Array(32)).buffer;
    const key = await deriveKey(prfOutput);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.byteLength).toBe(32);
  });

  it('returns the same key for the same PRF output', async () => {
    const prfOutput = crypto.getRandomValues(new Uint8Array(32)).buffer;
    const key1 = await deriveKey(prfOutput);
    const key2 = await deriveKey(prfOutput);
    expect(Array.from(key1)).toEqual(Array.from(key2));
  });

  it('returns different keys for different PRF outputs', async () => {
    const a = crypto.getRandomValues(new Uint8Array(32)).buffer;
    const b = crypto.getRandomValues(new Uint8Array(32)).buffer;
    const key1 = await deriveKey(a);
    const key2 = await deriveKey(b);
    expect(Array.from(key1)).not.toEqual(Array.from(key2));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/client/auth/deriveKey.tests.ts`
Expected: FAIL — `deriveKey` not found.

- [ ] **Step 3: Create deriveKey.ts**

```ts
// src/client/auth/deriveKey.ts
const PRF_SALT = new TextEncoder().encode('mxdb-sqlite-encryption-key-v1');

/**
 * Derives a 32-byte AES-GCM key from a WebAuthn PRF output via HKDF-SHA-256.
 * The salt matches the original deriveEncryptionKey.ts so existing databases remain readable.
 */
export async function deriveKey(prfOutput: ArrayBuffer): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveBits']);
  const keyBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: PRF_SALT, info: new Uint8Array(0) },
    baseKey,
    256,
  );
  return new Uint8Array(keyBits);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/client/auth/deriveKey.tests.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/auth/deriveKey.ts src/client/auth/deriveKey.tests.ts
git commit -m "feat(auth): add deriveKey — HKDF-SHA256 from PRF output to AES key"
```

---

## Task 5: Remove obsolete internal events and actions

**Files:**
- Modify: `src/common/internalEvents.ts`
- Modify: `src/common/internalActions.ts`

These events/actions were part of the old token-rotation and mxdb-specific auth flow. All are replaced by socket-api equivalents.

- [ ] **Step 1: Rewrite internalEvents.ts**

```ts
// src/common/internalEvents.ts
// All auth events (mxdbTokenRotated, mxdbDeviceBlocked, mxdbUserAuthenticated) are
// removed — replaced by socket-api's socketAPIUserChanged and socketAPIDeviceDisabled.
// This file is kept because mxdbServerToClientSyncAction uses defineEvent indirectly
// via the actions file; events themselves are now empty.
export {};
```

- [ ] **Step 2: Rewrite internalActions.ts**

Remove `mxdbSignOutAction`. Keep sync-related actions:

```ts
// src/common/internalActions.ts
import { defineAction } from '@anupheaus/nexus/common';
import type {
  DistinctRequest,
  DistinctResponse,
  GetAllRequest,
  GetRequest,
  GetResponse,
  QueryRequest,
  QueryResponse,
  ReconcileRequest,
  ReconcileResponse,
} from './models';
import type {
  ClientDispatcherRequest,
  MXDBRecordCursors,
  MXDBSyncEngineResponse,
} from './sync-engine';

export const mxdbClientToServerSyncAction = defineAction<ClientDispatcherRequest, MXDBSyncEngineResponse>()('mxdbClientToServerSyncAction');
export const mxdbServerToClientSyncAction = defineAction<MXDBRecordCursors, MXDBSyncEngineResponse>()('mxdbServerToClientSyncAction');
export const mxdbReconcileAction = defineAction<ReconcileRequest, ReconcileResponse>()('mxdbReconcileAction');
export const mxdbGetAction = defineAction<GetRequest, GetResponse>()('mxdbGetAction');
export const mxdbGetAllAction = defineAction<GetAllRequest, GetResponse>()('mxdbGetAllAction');
export const mxdbQueryAction = defineAction<QueryRequest, QueryResponse>()('mxdbQueryAction');
export const mxdbDistinctAction = defineAction<DistinctRequest, DistinctResponse>()('mxdbDistinctAction');
```

- [ ] **Step 3: Remove signOutAction.ts on the server side**

Check `src/server/actions/signOutAction.ts` exists. If it does, delete it and remove its import from `src/server/actions/internalActions.ts`.

Run: `ls src/server/actions/`
If `signOutAction.ts` exists:
- Delete: `src/server/actions/signOutAction.ts`
- Edit `src/server/actions/internalActions.ts` to remove its registration.

- [ ] **Step 4: Commit**

```bash
git add src/common/internalEvents.ts src/common/internalActions.ts
git commit -m "refactor(auth): remove token-rotation and auth events/actions — replaced by socket-api"
```

---

## Task 6: Rewrite server useAuth.ts

**Files:**
- Rewrite: `src/server/auth/useAuth.ts`

Remove `MutableAuthState`, `setAuthState`, `getAuthState`, `clearAuthState`. The new `useAuth()` is a thin typed wrapper over socket-api's `useAuthentication`.

- [ ] **Step 1: Rewrite useAuth.ts**

```ts
// src/server/auth/useAuth.ts
import { useAuthentication } from '@anupheaus/nexus/server';
import type { MXDBUserDetails } from '../../common/models';

export interface UseAuthResult {
  readonly user: MXDBUserDetails | undefined;
  setUser(user: MXDBUserDetails | undefined): Promise<void>;
  signOut(): Promise<void>;
  createInvite(userId: string, baseUrl: string): Promise<string>;
}

/**
 * Returns the current user and auth helpers for use inside action/subscription handlers.
 * Must be called within an authenticated socket-api handler context.
 */
export function useAuth(): UseAuthResult {
  return useAuthentication<MXDBUserDetails>();
}
```

- [ ] **Step 2: Verify TypeScript compiles for this file**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep useAuth`
Expected: no errors for useAuth.ts itself (other files may still error).

- [ ] **Step 3: Commit**

```bash
git add src/server/auth/useAuth.ts
git commit -m "refactor(auth): simplify server useAuth to delegate to socket-api useAuthentication"
```

---

## Task 7: Update server internalModels.ts

**Files:**
- Modify: `src/server/internalModels.ts`

Remove `inviteLinkTTLMs` from `ServerConfig`. Remove `deviceInfo` from `onConnected` / `onDisconnected` callbacks. Remove `onGetUserDetails` requirement (it becomes optional — passed internally to `configureAuthentication`).

- [ ] **Step 1: Rewrite internalModels.ts**

```ts
// src/server/internalModels.ts
import type { Http2Server } from 'http2';
import type { Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';
import type { MXDBDeviceInfo, MXDBUserDetails } from '../common/models';
import type { MXDBCollection } from '../common';
import type { ServerConfig as StartSocketServerConfig } from '@anupheaus/nexus/server';
import type { PromiseMaybe } from '@anupheaus/common';
import type Koa from 'koa';

export type AnyHttpServer = Http2Server | HttpServer | HttpsServer;

export { Koa };
export interface ServerConfig extends StartSocketServerConfig {
  collections: MXDBCollection[];
  mongoDbUrl: string;
  mongoDbName: string;
  clearDatabase?: boolean;
  shouldSeedCollections?: boolean;
  changeStreamDebounceMs?: number;
  /**
   * Called during WebAuthn registration/reauth to fetch full user details for the userId.
   * Passed to socket-api's configureAuthentication.onGetUser.
   */
  onGetUserDetails?(userId: string): Promise<MXDBUserDetails>;
  /** Called after a client successfully authenticates. */
  onConnected?(ctx: { user: MXDBUserDetails }): PromiseMaybe<void>;
  /**
   * Called when an authenticated client disconnects.
   * reason: 'signedOut' when the client explicitly signed out, 'connectionLost' otherwise.
   */
  onDisconnected?(ctx: { user: MXDBUserDetails; reason: 'signedOut' | 'connectionLost' }): PromiseMaybe<void>;
}

export interface ServerInstance {
  app: Koa;
  createInvite(userId: string, baseUrl: string): Promise<string>;
  getDevices(userId: string): Promise<MXDBDeviceInfo[]>;
  enableDevice(requestId: string): Promise<void>;
  disableDevice(requestId: string): Promise<void>;
  close(): Promise<void>;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/internalModels.ts
git commit -m "refactor(auth): update ServerConfig — remove inviteLinkTTLMs, remove deviceInfo from callbacks"
```

---

## Task 8: Add registerDevAuthRoute.ts

**Files:**
- Create: `src/server/auth/registerDevAuthRoute.ts`

Non-production only. POSTing `{ userId }` creates/updates a `WebAuthnAuthRecord` with a fresh `sessionToken` and sets the `socketapi_session` cookie, so dev bypass exercises the same cookie-validation path as production.

- [ ] **Step 1: Create registerDevAuthRoute.ts**

```ts
// src/server/auth/registerDevAuthRoute.ts
import crypto from 'crypto';
import type Router from 'koa-router';
import type { ServerDb } from '../providers';
import { AuthCollection } from './AuthCollection';

const COOKIE_NAME = 'socketapi_session';
const DEV_SESSION_TOKEN_PREFIX = 'dev-bypass-';

function buildSetCookieHeader(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export function registerDevAuthRoute(router: Router, name: string, db: ServerDb): void {
  router.post(`/${name}/dev/signin`, async ctx => {
    const body = ctx.request.body as Record<string, unknown>;
    const userId = body?.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
      ctx.status = 400;
      return;
    }
    const requestId = `dev-bypass-${userId}`;
    const sessionToken = `${DEV_SESSION_TOKEN_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
    const authColl = new AuthCollection(db);
    const existing = await authColl.findById(requestId);
    if (existing != null) {
      await authColl.update(requestId, { sessionToken, isEnabled: true });
    } else {
      await authColl.create({
        requestId,
        userId,
        sessionToken,
        deviceId: 'dev-bypass',
        isEnabled: true,
        deviceDetails: undefined,
      });
    }
    ctx.set('Set-Cookie', buildSetCookieHeader(sessionToken));
    ctx.status = 200;
    ctx.body = { ok: true, userId };
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/auth/registerDevAuthRoute.ts
git commit -m "feat(auth): add /dev/signin route — issues real cookie for non-production dev bypass"
```

---

## Task 9: Rewrite startAuthenticatedServer.ts

**Files:**
- Rewrite: `src/server/startAuthenticatedServer.ts`

Remove all token-rotation machinery. Use `defineAuthentication` so socket-api validates the `socketapi_session` cookie. Track connected users via a WeakMap for `onDisconnected` reason detection.

- [ ] **Step 1: Rewrite startAuthenticatedServer.ts**

```ts
// src/server/startAuthenticatedServer.ts
import type { ServerDb } from './providers';
import { setServerToClientSync } from './providers';
import { seedCollections } from './seeding';
import { internalActions } from './actions';
import { startServer as startSocketServer, useSocketAPI, useAction } from '@anupheaus/nexus/server';
import { defineAuthentication } from '@anupheaus/nexus/server';
import { internalSubscriptions } from './subscriptions';
import { addClientWatches, removeClientWatches } from './clientDbWatches';
import { ServerToClientSynchronisation } from './ServerToClientSynchronisation';
import { AuthCollection } from './auth/AuthCollection';
import { mxdbServerToClientSyncAction } from '../common/internalActions';
import type { Socket } from 'socket.io';
import type { ServerConfig } from './internalModels';
import { Logger } from '@anupheaus/common';
import type { MXDBUserDetails } from '../common/models';

const clientS2CInstances = new WeakMap<Socket, ServerToClientSynchronisation>();
const connectedUsers = new WeakMap<Socket, MXDBUserDetails>();
const disconnectReasons = new WeakMap<Socket, string>();

const adminUser = { id: Math.emptyId() } as MXDBUserDetails;

interface Props extends ServerConfig {
  db: ServerDb;
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
  onGetUserDetails,
  changeStreamDebounceMs,
  ...config
}: Props) {
  const { configureAuthentication, useAuthentication } = defineAuthentication<MXDBUserDetails>();
  const authColl = new AuthCollection(db);

  logger?.info('[startAuthenticatedServer] calling startSocketServer');
  const { app } = await startSocketServer({
    ...config,
    logger,
    actions: [...internalActions, ...(actions ?? [])],
    subscriptions: [...internalSubscriptions, ...(subscriptions ?? [])],

    auth: configureAuthentication({
      mode: 'webauthn',
      store: authColl,
      onGetUserDetails: async (userId) => {
        const details = onGetUserDetails != null
          ? await onGetUserDetails(userId)
          : { id: userId, name: userId } as MXDBUserDetails;
        return { name: details.name, displayName: details.displayName };
      },
      onGetUser: async (userId): Promise<MXDBUserDetails | undefined> => {
        if (onGetUserDetails == null) return { id: userId, name: userId } as MXDBUserDetails;
        try { return await onGetUserDetails(userId); }
        catch { return undefined; }
      },
    }),

    async onStartup() {
      logger?.info('[startAuthenticatedServer] onStartup.begin');
      const { impersonateUser } = useAuthentication();

      await impersonateUser(adminUser, async () => {
        const startupLogger = (logger ?? Logger.getCurrent() ?? new Logger('mxdb-sync')).createSubLogger('s2c:startup');
        setServerToClientSync(ServerToClientSynchronisation.createNoOp(collections, startupLogger));
        const startTime = Date.now();
        if (shouldSeedCollections === true) {
          await seedCollections(collections);
        }
        console.log(`Seeding took ${Date.now() - startTime}ms`); // eslint-disable-line no-console
        if (config.onStartup != null) await config.onStartup();
      });
      logger?.info('[startAuthenticatedServer] onStartup.done');
    },

    onClientConnected: async (client: Socket) => {
      // Track disconnect reason by listening to socket's raw disconnect event.
      client.once('disconnect', (reason: string) => disconnectReasons.set(client, reason));

      const { user } = useAuthentication();

      if (user != null) {
        connectedUsers.set(client, user);
        await onConnected?.({ user });
      }

      const s2cLogger = (logger ?? Logger.getCurrent() ?? new Logger('mxdb-sync')).createSubLogger(`s2c:${client.id}`);
      const emitS2C = useAction(mxdbServerToClientSyncAction);
      const s2c = new ServerToClientSynchronisation({
        emitS2C: async payload => emitS2C(payload),
        getDb: () => db,
        collections,
        logger: s2cLogger,
      });
      clientS2CInstances.set(client, s2c);
      setServerToClientSync(s2c);
      addClientWatches(client, collections, s2c);
      await onClientConnected?.(client);
    },

    onClientDisconnected: async client => {
      removeClientWatches(client);

      const s2c = clientS2CInstances.get(client);
      if (s2c != null) {
        s2c.close();
        clientS2CInstances.delete(client);
      }

      const user = connectedUsers.get(client);
      connectedUsers.delete(client);

      if (user != null) {
        // 'server namespace disconnect' = explicit server-side disconnect (sign-out or device disabled).
        const rawReason = disconnectReasons.get(client) ?? '';
        const reason = rawReason === 'server namespace disconnect' ? 'signedOut' : 'connectionLost';
        disconnectReasons.delete(client);
        await onDisconnected?.({ user, reason });
      }

      await onClientDisconnected?.(client);
    },
  });

  logger?.info('[startAuthenticatedServer] done');
  return { app, authColl, useAuthentication };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/startAuthenticatedServer.ts
git commit -m "refactor(auth): rewrite startAuthenticatedServer — use defineAuthentication, remove token rotation"
```

---

## Task 10: Rewrite startServer.ts

**Files:**
- Rewrite: `src/server/startServer.ts`

Remove `setAuthConfig`, `registerAuthInviteRoute`, `createDevToken`. Surface `createInvite` from socket-api's `useAuthentication`. Register dev auth route when non-production.

- [ ] **Step 1: Rewrite startServer.ts**

```ts
// src/server/startServer.ts
import { provideDb } from './providers';
import { Logger } from '@anupheaus/common';
import { startAuthenticatedServer } from './startAuthenticatedServer';
import { getDevices, enableDevice, disableDevice } from './auth/deviceManagement';
import { registerDevAuthRoute } from './auth/registerDevAuthRoute';
import type { ServerConfig, ServerInstance } from './internalModels';

export async function startServer(config: ServerConfig): Promise<ServerInstance> {
  let { logger, name, collections, mongoDbName, mongoDbUrl, changeStreamDebounceMs, onRegisterRoutes } = config;
  if (!logger) logger = Logger.getCurrent();
  if (!logger) logger = new Logger('MXDB-Sync');

  logger.info('[startServer] begin', { name, mongoDbName, collectionCount: collections.length });

  return logger.provide(() => provideDb(mongoDbName, mongoDbUrl, collections, async db => {
    logger!.info('[startServer] provideDb — waiting for Mongo');
    await db.getMongoDb();
    logger!.info('[startServer] Mongo connected');

    const { app, useAuthentication } = await startAuthenticatedServer({
      ...config,
      db,
      logger,
      onRegisterRoutes: async router => {
        await onRegisterRoutes?.(router);
        if (process.env.NODE_ENV !== 'production') {
          registerDevAuthRoute(router, name, db);
        }
      },
    });

    if (app == null) throw new Error('Failed to start server');

    return {
      app,
      createInvite: async (userId: string, baseUrl: string) =>
        useAuthentication().createInvite(userId, baseUrl),
      getDevices: async (userId: string) => getDevices(db, userId),
      enableDevice: async (requestId: string) => enableDevice(db, requestId),
      disableDevice: async (requestId: string) => disableDevice(db, requestId),
      close: async () => db.close(),
    };
  }, changeStreamDebounceMs));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/startServer.ts
git commit -m "refactor(auth): rewrite startServer — remove invite route, surface createInvite from socket-api"
```

---

## Task 11: Update server index.ts

**Files:**
- Modify: `src/server/index.ts`

Remove `MXDBAuthRecord` (internal; replaced by socket-api's `WebAuthnAuthRecord`). Keep `MXDBDeviceInfo` (used by `getDevices` return type). Keep `useAuth`.

- [ ] **Step 1: Rewrite server index.ts**

```ts
// src/server/index.ts
export * from './startServer';
export * from './collections';
export type { MXDBDeviceInfo } from '../common/models';
export { useAuth } from './auth/useAuth';
```

- [ ] **Step 2: Commit**

```bash
git add src/server/index.ts
git commit -m "refactor: update server index — remove MXDBAuthRecord export"
```

---

## Task 12: Add MXDBSyncInner.tsx

**Files:**
- Create: `src/client/auth/MXDBSyncInner.tsx`

This is the core new component. It lives inside `<SocketAPI>` and owns:
- Dev bypass check (localStorage → skip signIn, use fixed key)
- Reauth trigger when `user` transitions `undefined → defined` with no key
- `encryptionKey` state
- BroadcastChannel for cross-tab sign-out
- Conditional mount of `DbsProvider` → sync providers

- [ ] **Step 1: Create MXDBSyncInner.tsx**

```tsx
// src/client/auth/MXDBSyncInner.tsx
import { createComponent, useLogger } from '@anupheaus/react-ui';
import type { ReactNode } from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuthentication } from '@anupheaus/nexus/client';
import { DbsProvider } from '../providers/dbs';
import { ClientToServerSyncProvider, ClientToServerProvider } from '../providers/client-to-server';
import { ServerToClientProvider } from '../providers/server-to-client';
import { deriveKey } from './deriveKey';
import type { MXDBCollection, MXDBError } from '../../common';
import type { MXDBUserDetails } from '../../common/models';

interface Props {
  appName: string;
  collections: MXDBCollection[];
  onError?(error: MXDBError): void;
  onDeviceDisabled?(): void;
  onSignedIn?(user: MXDBUserDetails): void;
  onSignedOut?(): void;
  children?: ReactNode;
}

export const MXDBSyncInner = createComponent('MXDBSyncInner', ({
  appName,
  collections,
  onError,
  onDeviceDisabled,
  onSignedIn,
  onSignedOut,
  children,
}: Props) => {
  const logger = useLogger('MXDBSyncInner');
  const { user, signIn, signOut } = useAuthentication<MXDBUserDetails>();
  const [encryptionKey, setEncryptionKey] = useState<Uint8Array | undefined>();
  const [dbName, setDbName] = useState<string | undefined>();
  const channelRef = useRef<BroadcastChannel | null>(null);
  const prevUserRef = useRef<MXDBUserDetails | undefined>(undefined);
  const reauthInProgressRef = useRef(false);

  // ── Dev bypass (non-production only) ──────────────────────────────────────
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const devJson = typeof localStorage !== 'undefined'
      ? localStorage.getItem(`mxdb:dev-auth:${appName}`)
      : null;
    if (devJson == null) return;
    try {
      const { userId } = JSON.parse(devJson) as { userId: string };
      logger.info('[dev] Using dev bypass auth');
      localStorage.removeItem(`mxdb:dev-auth:${appName}`);
      setDbName(userId);
      setEncryptionKey(new Uint8Array(32).fill(0xde));
    } catch {
      localStorage.removeItem(`mxdb:dev-auth:${appName}`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── BroadcastChannel: cross-tab sign-out ─────────────────────────────────
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
    return () => { channel.close(); channelRef.current = null; };
  }, [appName]);

  // ── Reauth when user becomes defined but no key in memory ─────────────────
  useEffect(() => {
    const prev = prevUserRef.current;
    prevUserRef.current = user;

    if (user == null && prev != null) {
      // User signed out
      setEncryptionKey(undefined);
      setDbName(undefined);
      channelRef.current?.postMessage({ type: 'signed-out' });
      onSignedOut?.();
      return;
    }

    if (user != null && prev == null) {
      onSignedIn?.(user);
    }

    // User is present but no encryption key — trigger WebAuthn reauth ceremony.
    if (user != null && encryptionKey == null && !reauthInProgressRef.current) {
      reauthInProgressRef.current = true;
      signIn().catch((err: unknown) => {
        reauthInProgressRef.current = false;
        onError?.({
          code: 'AUTH_FAILED',
          message: err instanceof Error ? err.message : 'WebAuthn reauth failed',
          severity: 'fatal',
          originalError: err,
        });
      });
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── onPrf: called by SocketAPI after WebAuthn ceremony ────────────────────
  // This callback is wired up in MXDBSync.tsx via the onPrf prop on <SocketAPI>.
  // We expose a stable handler via a ref so MXDBSync can pass it to SocketAPI.
  // The actual wiring is: SocketAPI.onPrf → MXDBSync.handlePrf → sets key here.
  // MXDBSync passes handlePrf to this component via a setOnPrf callback.

  const handlePrf = useCallback(async (userId: string, prfOutput: ArrayBuffer) => {
    try {
      const key = await deriveKey(prfOutput);
      setEncryptionKey(key);
      setDbName(userId);
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sign-out ──────────────────────────────────────────────────────────────
  const handleSignOut = useCallback(async () => {
    setEncryptionKey(undefined);
    setDbName(undefined);
    channelRef.current?.postMessage({ type: 'signed-out' });
    await signOut();
  }, [signOut]);

  // Expose handlePrf and handleSignOut upwards via a context or ref.
  // MXDBSync needs handlePrf to pass to SocketAPI's onPrf prop.
  // We use MXDBSyncInnerContext for this.
  // (Context defined below this component.)
  useMXDBSyncInnerContext(handlePrf, handleSignOut);

  if (encryptionKey == null || dbName == null) {
    // Not yet authenticated — render children (login/loading state) without DbsProvider.
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

**Note:** The design passes `onPrf` to `<SocketAPI>` in `MXDBSync.tsx`. `SocketAPI` calls `onPrf(userId, prfOutput)` after each WebAuthn ceremony. We wire this by passing `onPrf` directly from `MXDBSync` to `SocketAPI`, and `MXDBSync` needs access to `MXDBSyncInner`'s `handlePrf`. Use a ref forwarding pattern — expose `handlePrf` from `MXDBSyncInner` via a context, then read it from `MXDBSync` level.

Revised approach — simpler: `MXDBSync` holds a ref-based callback `onPrfRef` that it creates and passes to both `SocketAPI` (as `onPrf`) and to `MXDBSyncInner` (as a `setOnPrf` setter that `MXDBSyncInner` calls once to register its handler). This avoids a context. Rewrite:

```tsx
// src/client/auth/MXDBSyncInner.tsx
import { createComponent, useLogger } from '@anupheaus/react-ui';
import type { ReactNode, MutableRefObject } from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuthentication } from '@anupheaus/nexus/client';
import { DbsProvider } from '../providers/dbs';
import { ClientToServerSyncProvider, ClientToServerProvider } from '../providers/client-to-server';
import { ServerToClientProvider } from '../providers/server-to-client';
import { deriveKey } from './deriveKey';
import type { MXDBCollection, MXDBError } from '../../common';
import type { MXDBUserDetails } from '../../common/models';

interface Props {
  appName: string;
  collections: MXDBCollection[];
  onPrfRef: MutableRefObject<((userId: string, prfOutput: ArrayBuffer) => void) | undefined>;
  onError?(error: MXDBError): void;
  onDeviceDisabled?(): void;
  onSignedIn?(user: MXDBUserDetails): void;
  onSignedOut?(): void;
  children?: ReactNode;
}

export const MXDBSyncInner = createComponent('MXDBSyncInner', ({
  appName,
  collections,
  onPrfRef,
  onError,
  onSignedIn,
  onSignedOut,
  children,
}: Props) => {
  const logger = useLogger('MXDBSyncInner');
  const { user, signIn } = useAuthentication<MXDBUserDetails>();
  const [encryptionKey, setEncryptionKey] = useState<Uint8Array | undefined>();
  const [dbName, setDbName] = useState<string | undefined>();
  const channelRef = useRef<BroadcastChannel | null>(null);
  const prevUserRef = useRef<MXDBUserDetails | undefined>(undefined);
  const reauthInProgressRef = useRef(false);

  // ── Dev bypass ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const devJson = typeof localStorage !== 'undefined'
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

  // ── BroadcastChannel: cross-tab sign-out ─────────────────────────────────
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
    return () => { channel.close(); channelRef.current = null; };
  }, [appName]);

  // ── Wire onPrf handler into the ref MXDBSync holds ───────────────────────
  useEffect(() => {
    onPrfRef.current = async (userId: string, prfOutput: ArrayBuffer) => {
      try {
        const key = await deriveKey(prfOutput);
        setEncryptionKey(key);
        setDbName(userId);
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
    return () => { onPrfRef.current = undefined; };
  }, [onPrfRef, onError]);

  // ── React to user state changes ──────────────────────────────────────────
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
    }

    if (user != null && encryptionKey == null && !reauthInProgressRef.current) {
      reauthInProgressRef.current = true;
      signIn().catch((err: unknown) => {
        reauthInProgressRef.current = false;
        onError?.({
          code: 'AUTH_FAILED',
          message: err instanceof Error ? err.message : 'WebAuthn reauth failed',
          severity: 'fatal',
          originalError: err,
        });
      });
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

- [ ] **Step 2: Commit**

```bash
git add src/client/auth/MXDBSyncInner.tsx
git commit -m "feat(auth): add MXDBSyncInner — reauth trigger, key state, BroadcastChannel, DbsProvider"
```

---

## Task 13: Rewrite MXDBSync.tsx

**Files:**
- Rewrite: `src/client/MXDBSync.tsx`

Replace old nested provider hierarchy (IndexedDbProvider → AuthProvider → TokenProvider → SocketProvider) with SocketAPI → MXDBSyncInner.

- [ ] **Step 1: Rewrite MXDBSync.tsx**

```tsx
// src/client/MXDBSync.tsx
import { createComponent } from '@anupheaus/react-ui';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import type { Logger } from '@anupheaus/common';
import { LoggerProvider } from '@anupheaus/react-ui';
import { SocketAPI } from '@anupheaus/nexus/client';
import { ConflictResolutionContext } from './providers';
import { MXDBSyncInner } from './auth/MXDBSyncInner';
import { setupBrowserTools } from './utils/setupBrowserTools';
import type { MXDBCollection, MXDBError } from '../common';
import type { MXDBUserDetails } from '../common/models';

interface Props {
  host?: string;
  name: string;
  logger?: Logger;
  collections: MXDBCollection[];
  onDeviceDisabled?(): void;
  onSignedIn?(user: MXDBUserDetails): void;
  onSignedOut?(): void;
  onError?(error: MXDBError): void;
  onConflictResolution?(message: string): Promise<boolean>;
  children?: ReactNode;
}

export const MXDBSync = createComponent('MXDBSync', ({
  host,
  name,
  logger,
  collections,
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

  // onPrfRef is created here and passed to both <SocketAPI onPrf> and <MXDBSyncInner>.
  // MXDBSyncInner registers its handler into this ref; SocketAPI fires it after each ceremony.
  const onPrfRef = useRef<((userId: string, prfOutput: ArrayBuffer) => void) | undefined>(undefined);

  return (
    <LoggerProvider logger={logger} loggerName="MXDB-Sync">
      <ConflictResolutionContext.Provider value={conflictResolutionContext}>
        <SocketAPI
          name={name}
          host={host}
          onPrf={(userId, prfOutput) => onPrfRef.current?.(userId, prfOutput)}
          onDeviceDisabled={onDeviceDisabled}
          onSignedIn={onSignedIn as any}
          onSignedOut={onSignedOut}
        >
          <MXDBSyncInner
            appName={name}
            collections={collections}
            onPrfRef={onPrfRef}
            onError={onError}
            onDeviceDisabled={onDeviceDisabled}
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

- [ ] **Step 2: Commit**

```bash
git add src/client/MXDBSync.tsx
git commit -m "refactor(auth): rewrite MXDBSync — SocketAPI + MXDBSyncInner hierarchy"
```

---

## Task 14: Update client hooks

**Files:**
- Rewrite: `src/client/hooks/useAuth.ts`
- Rewrite: `src/client/hooks/useMXDBSignOut.ts`
- Rewrite: `src/client/hooks/useMXDBUserId.ts`
- Delete: `src/client/hooks/useMXDBInvite.ts`
- Modify: `src/client/hooks/index.ts`

- [ ] **Step 1: Rewrite useAuth.ts**

```ts
// src/client/hooks/useAuth.ts
import { useAuthentication } from '@anupheaus/nexus/client';
import type { MXDBUserDetails } from '../../common/models';

export interface UseAuthResult {
  isAuthenticated: boolean;
  user: MXDBUserDetails | undefined;
  signOut(): Promise<void>;
}

export function useAuth(): UseAuthResult {
  const { user, signOut } = useAuthentication<MXDBUserDetails>();
  return {
    isAuthenticated: user != null,
    user,
    signOut,
  };
}
```

- [ ] **Step 2: Rewrite useMXDBSignOut.ts**

```ts
// src/client/hooks/useMXDBSignOut.ts
import { useAuthentication } from '@anupheaus/nexus/client';

export function useMXDBSignOut(): { signOut(): Promise<void> } {
  const { signOut } = useAuthentication();
  return { signOut };
}
```

- [ ] **Step 3: Rewrite useMXDBUserId.ts**

```ts
// src/client/hooks/useMXDBUserId.ts
import { useAuthentication } from '@anupheaus/nexus/client';

export function useMXDBUserId(): string | undefined {
  return useAuthentication().user?.id;
}
```

- [ ] **Step 4: Update hooks/index.ts — remove useMXDBInvite**

```ts
// src/client/hooks/index.ts
export * from './useCollection';
export * from './useAuth';
export * from './useMXDBSignOut';
export * from './useMXDBUserId';
```

- [ ] **Step 5: Delete useMXDBInvite.ts**

Invite flow is now automatic: the app navigates to the invite URL (`?requestId=`), `MXDBSyncInner` calls `signIn()`, socket-api detects `?requestId=` and runs the registration ceremony. No explicit `register(url)` call is needed.

```bash
rm src/client/hooks/useMXDBInvite.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/client/hooks/useAuth.ts src/client/hooks/useMXDBSignOut.ts src/client/hooks/useMXDBUserId.ts src/client/hooks/index.ts
git commit -m "refactor(auth): update client hooks to use socket-api useAuthentication"
```

---

## Task 15: Update setupBrowserTools.ts

**Files:**
- Modify: `src/client/utils/setupBrowserTools.ts`

`setDevAuth` now calls the new `/dev/signin` POST route and stores only `userId` in localStorage (no `token`/`keyHash`). `MXDBSyncInner` reads this on mount.

- [ ] **Step 1: Update setDevAuth in setupBrowserTools.ts**

Replace the dev-only block:

```ts
if (process.env.NODE_ENV !== 'production') {
  tools['setDevAuth'] = async (userId: string) => {
    const res = await fetch(`/${appName}/dev/signin`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw new Error(`Dev auth failed: ${res.status}`);
    localStorage.setItem(`mxdb:dev-auth:${appName}`, JSON.stringify({ userId }));
    window.location.reload();
  };
  tools['clearDevAuth'] = () => {
    localStorage.removeItem(`mxdb:dev-auth:${appName}`);
    window.location.reload();
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/client/utils/setupBrowserTools.ts
git commit -m "refactor(auth): update setDevAuth to call /dev/signin and store userId only"
```

---

## Task 16: Update client index.ts

**Files:**
- Modify: `src/client/index.ts`

Re-export `useAuthentication` from socket-api so consumers never import from `@anupheaus/nexus` directly. Remove `mxdbDeviceBlocked` (no longer a mxdb-sync concern).

- [ ] **Step 1: Rewrite client index.ts**

```ts
// src/client/index.ts
export * from './MXDBSync';
export * from './useMXDBSync';
export * from './useRecord';
export * from './hooks';
export type { MXDBCollectionEvent } from './providers/dbs/models';
export { useAuthentication } from '@anupheaus/nexus/client';
```

- [ ] **Step 2: Commit**

```bash
git add src/client/index.ts
git commit -m "feat: re-export useAuthentication from client index; remove mxdbDeviceBlocked export"
```

---

## Task 17: Delete obsolete files

**Files to delete:**
- `src/client/auth/AuthProvider.tsx`
- `src/client/auth/TokenProvider.tsx`
- `src/client/auth/SocketProvider.tsx`
- `src/client/auth/IndexedDbProvider.tsx`
- `src/client/auth/IndexedDbContext.ts`
- `src/client/auth/IndexedDbAuthStore.ts`
- `src/client/auth/AuthContext.ts`
- `src/client/auth/UserIdContext.ts`
- `src/client/auth/deriveEncryptionKey.ts`
- `src/server/auth/registerAuthInviteRoute.ts`
- `src/server/auth/TokenRotation.ts`
- `src/server/auth/authConfig.ts`
- `src/client/auth/AuthContext.tests.ts`
- `src/client/auth/IndexedDbAuthStore.tests.ts`
- `src/client/auth/IndexedDbContext.tests.ts`
- `src/client/auth/hooks.tests.tsx`

- [ ] **Step 1: Verify nothing imports the files being deleted**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Cannot find module|has no exported member" | head -30`

Fix any remaining import errors in files that weren't updated in earlier tasks.

- [ ] **Step 2: Delete the files**

```bash
git rm src/client/auth/AuthProvider.tsx src/client/auth/TokenProvider.tsx src/client/auth/SocketProvider.tsx
git rm src/client/auth/IndexedDbProvider.tsx src/client/auth/IndexedDbContext.ts src/client/auth/IndexedDbAuthStore.ts
git rm src/client/auth/AuthContext.ts src/client/auth/UserIdContext.ts src/client/auth/deriveEncryptionKey.ts
git rm src/server/auth/registerAuthInviteRoute.ts src/server/auth/TokenRotation.ts src/server/auth/authConfig.ts
git rm src/client/auth/AuthContext.tests.ts src/client/auth/IndexedDbAuthStore.tests.ts
git rm src/client/auth/IndexedDbContext.tests.ts src/client/auth/hooks.tests.tsx
```

- [ ] **Step 3: Full TypeScript compile check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: zero errors.

- [ ] **Step 4: Run unit tests**

Run: `pnpm test`
Expected: all remaining tests pass (deriveKey tests, sync engine tests, auditor tests, etc.).

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(auth): delete obsolete auth files — AuthProvider, TokenProvider, SocketProvider, IndexedDb*, authConfig, TokenRotation, registerAuthInviteRoute"
```

---

## Task 18: Final integration verification

**Files:** none new — read-only verification.

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: client and server bundles build without errors or warnings about missing modules.

- [ ] **Step 2: Run all unit tests**

Run: `pnpm test`
Expected: all unit tests pass.

- [ ] **Step 3: Check exports are correct**

Open the built client output. Verify `useAuthentication` is exported. Verify `mxdbDeviceBlocked` is NOT exported.

- [ ] **Step 4: Smoke-check the dev bypass path**

In a local dev environment:
1. Start the server
2. Open browser console: `await window.mxdb.setDevAuth('test-user-1')`
3. Verify page reloads and the sync providers mount (no WebAuthn prompt)
4. Verify `window.mxdb.clearDevAuth()` signs out and reloads

- [ ] **Step 5: Verify common auth model export from common index**

Check `src/common/models/index.ts` exports `MXDBAuthRecord` and `MXDBUserDetails`. If `MXDBAuthRecord` is no longer needed externally (it's now `WebAuthnAuthRecord` from socket-api), remove it from the common export.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: final cleanup after socket-api WebAuthn migration"
```

---

## Self-Review Checklist

| Spec Section | Covered by Task |
|-------------|----------------|
| testDisconnect/testReconnect rename | Task 1 |
| onPrf callback wiring | Tasks 12, 13 |
| onSignedIn / onSignedOut / onDeviceDisabled | Tasks 12, 13 |
| defineAuthentication server setup | Task 9 |
| WebAuthnAuthStore (AuthCollection) | Task 3 |
| Token rotation removal | Tasks 5, 9 |
| Invite flow (socket-api routes) | Tasks 9, 10 |
| createInvite exposed on ServerInstance | Task 10 |
| sessionToken / deviceId in MXDBAuthRecord | Tasks 2, 3 |
| MXDBSyncInner reauth trigger | Task 12 |
| Reauth on page reload | Task 12 |
| Encryption key derivation (deriveKey) | Task 4 |
| BroadcastChannel cross-tab sign-out | Task 12 |
| Dev bypass route (server) | Task 8 |
| Dev bypass client (setupBrowserTools) | Task 15 |
| Dev bypass in MXDBSyncInner | Task 12 |
| onConnected / onDisconnected shape | Task 7, 9 |
| useAuthentication re-export | Task 16 |
| Delete obsolete files | Task 17 |
| Client hooks updated | Task 14 |
| mxdbDeviceBlocked export removed | Task 16 |
| MXDBAuthRecord model updated | Task 2 |
