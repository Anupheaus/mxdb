# mxdb-sync: socket-api WebAuthn Migration Design

**Date:** 2026-04-20
**Status:** Approved for implementation

---

## Overview

socket-api now implements WebAuthn end-to-end: client ceremonies (`signIn()` with PRF), server routes (`/invite`, `/register`, `/reauth`), cookie-based sessions, and lifecycle callbacks on `SocketAPI` (`onPrf`, `onSignedIn`, `onSignedOut`, `onDeviceDisabled`). mxdb-sync duplicates large parts of this — its own WebAuthn flows, token rotation, invite routes, and IndexedDB credential store. This design migrates mxdb-sync to delegate all of that to socket-api, retaining only what is genuinely mxdb-sync-specific: encryption key derivation from the PRF output, encrypted OPFS database lifecycle, device management, and cross-tab coordination.

### What changes

| Area | Before | After |
|------|--------|-------|
| WebAuthn ceremonies | mxdb-sync `AuthProvider` | socket-api `signIn()` |
| PRF → AES key | mxdb-sync `deriveEncryptionKey.ts` | mxdb-sync `onPrf` callback → `deriveKey.ts` |
| Session token storage | Encrypted SQLite (`db.readAuth/writeAuth`) | HttpOnly cookie (browser-managed) |
| Token rotation | `TokenRotation`, gate, `mxdbTokenRotated` event | Removed entirely |
| Invite + register routes | mxdb-sync `registerAuthInviteRoute` | socket-api `/socketAPI/webauthn/invite` + `/register` |
| Auth store shape | `currentToken`/`pendingToken` two-phase | `sessionToken` single field |
| Device blocked signal | `mxdbDeviceBlocked` event | socket-api `onDeviceDisabled` callback |
| User propagation | `mxdbUserAuthenticated` event | socket-api `onSignedIn` callback |
| connect/disconnect | `testDisconnect`/`testReconnect` | `disconnect`/`connect` (rename) |

---

## 1. socket-api API Surface Used

### `SocketAPI` props (new)

```tsx
<SocketAPI
  name={name}
  host={host}
  onPrf={(userId, prfOutput) => { /* derive AES key */ }}
  onSignedIn={(user) => { /* user authenticated */ }}
  onSignedOut={() => { /* user signed out */ }}
  onDeviceDisabled={() => { /* device administratively disabled */ }}
>
```

- **`onPrf(userId, prfOutput: ArrayBuffer)`** — fired after every successful WebAuthn ceremony (registration and reauth), before `reconnect()`. `userId` is the real user ID from the server response. `prfOutput` is the raw PRF result — mxdb-sync runs HKDF internally and socket-api never sees the derived key.
- **`onSignedIn(user)`** — fired when `socketAPIUserChanged` transitions `undefined → user`. On page reload with a valid cookie this fires automatically; mxdb-sync uses it to trigger the reauth ceremony if no encryption key is in memory yet.
- **`onSignedOut()`** — fired when `socketAPIUserChanged` transitions `user → undefined`. mxdb-sync uses it to clear the in-memory key and notify other tabs.
- **`onDeviceDisabled()`** — fired when the server emits `socketAPIDeviceDisabled` before disconnecting. Replaces mxdb-sync's `mxdbDeviceBlocked` event.

### `useAuthentication()` (client, inside `SocketAPI`)

```ts
const { signIn, signOut, user } = useAuthentication();
signIn();           // WebAuthn: registration if ?requestId= present, else reauth
signOut();          // POST /signout, clears cookie, reconnects unauthenticated
```

### `defineAuthentication` (server)

```ts
const { configureAuthentication, useAuthentication } =
  defineAuthentication<MXDBUserDetails>();

// in startServer:
auth: configureAuthentication({
  mode: 'webauthn',
  store: authCollection,          // implements WebAuthnAuthStore
  onGetUserDetails: async (userId) => { name, displayName },
  onGetUser: async (userId) => MXDBUserDetails | undefined,
})

// in action/subscription handlers:
const { user, createInvite } = useAuthentication();
const inviteUrl = await createInvite(userId, baseUrl);
```

### `WebAuthnAuthStore` interface (from socket-api/common)

```ts
interface WebAuthnAuthStore extends SocketAPIAuthStore<WebAuthnAuthRecord> {
  findByRegistrationToken(token: string): Promise<WebAuthnAuthRecord | undefined>;
  findByKeyHash(keyHash: string): Promise<WebAuthnAuthRecord | undefined>;
}
```

---

## 2. Client: Component Hierarchy

### Before

```
MXDBSync
└─ LoggerProvider
   └─ ConflictResolutionContext.Provider
      └─ IndexedDbProvider           ← stores credential IDs + db names
         └─ AuthProvider             ← WebAuthn ceremonies, key derivation, IDB reads
            └─ TokenProvider         ← reads/writes token from SQLite, passes to SocketProvider
               └─ mxdb SocketProvider
                  └─ SocketAPI (socket-api)
                     └─ SocketInner  ← token rotation handler
                        └─ DbsProvider (keyed by encryptionKey + dbName)
                           └─ {children}
```

### After

```
MXDBSync
└─ LoggerProvider
   └─ ConflictResolutionContext.Provider
      └─ SocketAPI (socket-api, onPrf/onSignedIn/onSignedOut/onDeviceDisabled)
         └─ MXDBSyncInner            ← lifecycle: triggers reauth, manages key state
            └─ DbsProvider           ← mounted only when encryptionKey is set
               └─ ClientToServerSyncProvider
                  └─ ClientToServerProvider
                     └─ ServerToClientProvider
                        └─ {children}
```

### Files deleted

| File | Reason |
|------|--------|
| `src/client/auth/AuthProvider.tsx` | WebAuthn ceremonies moved to socket-api `signIn()` |
| `src/client/auth/TokenProvider.tsx` | Token now in HttpOnly cookie, not SQLite |
| `src/client/auth/SocketProvider.tsx` | Replaced by socket-api `SocketAPI` with callbacks |
| `src/client/auth/IndexedDbProvider.tsx` | Credential ID storage simplified (see §3) |
| `src/client/auth/IndexedDbContext.ts` | Same |
| `src/client/auth/IndexedDbAuthStore.ts` | Same |
| `src/client/auth/deriveEncryptionKey.ts` | Logic moved to `deriveKey.ts` (no IDB coupling) |

### Files changed

| File | Change |
|------|--------|
| `src/client/MXDBSync.tsx` | Restructured: wraps `SocketAPI`; props simplified (see §5) |
| `src/client/useMXDBSync.ts` | `testDisconnect`/`testReconnect` → `disconnect`/`connect` |

### Files added

| File | Purpose |
|------|---------|
| `src/client/auth/deriveKey.ts` | HKDF-SHA256 derivation from raw PRF output → `Uint8Array` AES key |
| `src/client/auth/MXDBSyncInner.tsx` | Inner component; triggers reauth, holds key state, mounts `DbsProvider` |

### Re-exports

mxdb-sync re-exports socket-api's `useAuthentication` so consumers never need to import from `@anupheaus/nexus` directly:

```ts
// src/client/index.ts
export { useAuthentication } from '@anupheaus/nexus';
```

`AuthContext.ts` is deleted entirely — no mxdb-sync auth context is kept. Consumers call `useAuthentication()` from the mxdb-sync package import and get socket-api's hook with full typing.

---

## 3. Client: Credential Storage

The current `IndexedDbAuthStore` stores `{ credentialId, dbName, isDefault }`. After migration:

- **`dbName` → `userId`** — the OPFS database is named after the user ID, which is returned by both `/register` and `/reauth` in the server response and passed as the first argument to `onPrf`. No need to store or look up a random name.
- **`credentialId`** — still needed to drive `navigator.credentials.get({ allowCredentials: [{ id: credentialId }] })` during reauth. However, passing `allowCredentials: []` (empty) lets the browser surface any registered passkey automatically, which avoids needing to store the credential ID at all. socket-api's `performWebAuthnReauth` already uses empty `allowCredentials`, so the credential ID store is eliminated entirely.

**Result:** `IndexedDbProvider`, `IndexedDbContext`, and `IndexedDbAuthStore` are removed with no replacement. The browser's passkey management handles credential selection.

---

## 4. Client: Reauth on Page Reload

On page reload a valid cookie is present. The flow:

1. `SocketAPI` mounts → socket connects with cookie → server validates → `socketAPIUserChanged` emitted
2. `AuthenticationProvider` fires `onSignedIn(user)`
3. `MXDBSyncInner` receives `onSignedIn`: no encryption key in state → calls `signIn()` (no args, no `?requestId=`) → WebAuthn reauth ceremony
4. `navigator.credentials.get()` runs → PRF output derived → `POST /reauth` → `{ userId }` returned → `onPrf(userId, prfOutput)` fires
5. `MXDBSyncInner` runs `deriveKey(prfOutput)` → stores AES key in state
6. `DbsProvider` mounts with `encryptionKey` + `dbName = userId` → sync starts

`MXDBSyncInner` holds a ref to `signIn` from `useAuthentication()` and calls it inside an effect triggered by the user state transition.

---

## 5. Client: `MXDBSync` Props

### Removed

| Prop | Reason |
|------|--------|
| `onInvalidToken` | Replaced by `onDeviceDisabled` |
| `onUnauthorisedOperation` | Moved to collection-level error handling (unchanged behaviour) |

### Added

| Prop | Type | Purpose |
|------|------|---------|
| `onDeviceDisabled` | `() => void` | Forwarded from socket-api `onDeviceDisabled` |
| `onSignedIn` | `(user: MXDBUserDetails) => void` | Forwarded from socket-api `onSignedIn` |
| `onSignedOut` | `() => void` | Forwarded from socket-api `onSignedOut`; mxdb-sync also uses this to clear state |

### Unchanged

`host`, `name`, `logger`, `collections`, `onError`, `onConflictResolution`, `children`.

---

## 6. Client: `useMXDBSync` Rename

```ts
// Before
const { testDisconnect, testReconnect, ... } = useMXDBSync();

// After
const { disconnect, connect, ... } = useMXDBSync();
```

Files to update: `src/client/useMXDBSync.ts`, `test/client/ConnectionTest.tsx`, `tests/e2e/setup/syncClient.tsx`, `README.md`, `docs/guides/client-guide.md`.

---

## 7. Client: Cross-Tab Sign-Out

`MXDBSyncInner` (or a hook it calls) owns a `BroadcastChannel('mxdb-auth-{name}')`.

- `onSignedOut` callback fires → mxdb-sync clears in-memory encryption key → `DbsProvider` unmounts → channel posts `{ type: 'signed-out' }`
- Other tabs receive the message → clear their key state → `DbsProvider` unmounts

This replaces the current logic in `AuthProvider`. The channel is opened on mount and closed on unmount.

---

## 8. Server: Auth Store Shape

`AuthCollection` currently uses `currentToken`/`pendingToken` (two-phase rotation). After migration it must implement `WebAuthnAuthStore`.

### Record shape change

| Before | After |
|--------|-------|
| `currentToken: string` | `sessionToken: string` |
| `pendingToken?: string` | *(removed)* |
| `registrationToken?: string` | `registrationToken?: string` *(kept)* |
| `keyHash?: string` | `keyHash?: string` *(kept)* |

### Method changes

| Before | After |
|--------|-------|
| `findByToken(token)` — searches `currentToken` then `pendingToken` | `findBySessionToken(token)` — searches `sessionToken` only |
| `findByKeyHash(keyHash)` | `findByKeyHash(keyHash)` *(kept)* |
| `findByRegistrationToken(token)` | `findByRegistrationToken(token)` *(kept)* |

Any existing MongoDB documents with `currentToken`/`pendingToken` fields need a migration or the store methods handle both old and new field names during a transition window.

---

## 9. Server: `startAuthenticatedServer` Changes

### Removed entirely

- `tokenRotationGates` WeakMap
- `onClientConnecting` callback (was the gate setup)
- `onBeforeHandle` deferred-promise gate
- Token validation block in `onClientConnected` (reads `handshake.auth.token`, calls `authColl.findByToken`, emits `mxdbDeviceBlocked`, emits `mxdbUserAuthenticated`, calls `emitTokenRotated`)
- `TokenRotation` import and usage
- `TokenRotation.ts` file

### `startAuthenticatedServer` becomes `startServer`

The function now delegates auth entirely to socket-api's `configureAuthentication`:

```ts
await startSocketServer({
  ...config,
  auth: configureAuthentication({
    mode: 'webauthn',
    store: new AuthCollection(db),
    onGetUserDetails: getAuthConfig().onGetUserDetails ?? (id => ({ name: id })),
    onGetUser: async (userId) => { /* fetch from db */ },
  }),
  onClientConnected: async (client) => {
    // user is already validated by socket-api's validateSessionCookie
    // set up S2C sync for this connection
    const s2c = new ServerToClientSynchronisation({ ... });
    clientS2CInstances.set(client, s2c);
    setServerToClientSync(s2c);
    addClientWatches(client, collections, s2c);
    await onClientConnected?.(client);
  },
  onClientDisconnected: async (client) => {
    // same as before — tear down S2C, notify consumer
  },
});
```

### `onConnected` / `onDisconnected` consumer callbacks

`onConnected` previously received `{ user: MXDBUserDetails, deviceInfo }`. After migration it receives `{ user: MXDBUserDetails }` only — `deviceInfo` was populated from `MutableAuthState` which is removed with the token rotation machinery. `onDisconnected` receives `{ user, reason: 'signedOut' | 'connectionLost' }` unchanged.

---

## 10. Server: Invite Flow

### Removed

- `src/server/auth/registerAuthInviteRoute.ts` — GET `/register` and POST `/register` mxdb-sync routes
- `src/server/auth/authConfig.ts` field `inviteLinkTTLMs` (invite TTL is now implicit in how long the `requestId` record sits in the store with `isEnabled: false`)

### Replaced by

socket-api routes registered automatically when `mode: 'webauthn'`:
- `GET /{name}/socketAPI/webauthn/invite?requestId=xxx`
- `POST /{name}/socketAPI/webauthn/register`
- `POST /{name}/socketAPI/webauthn/reauth`

### Expose `createInvite` to mxdb-sync consumers

`startServer` (mxdb-sync's public API) returns `createInvite`:

```ts
const { app, createInvite } = await startServer({ ... });
const url = await createInvite(userId, 'https://myapp.com');
```

Internally this calls socket-api's `useAuthentication().createInvite(userId, baseUrl)`.

---

## 11. Server: Removed Internal Events and Actions

| Symbol | File | Reason |
|--------|------|--------|
| `mxdbTokenRotated` | `src/common/internalEvents.ts` | Token rotation removed |
| `mxdbDeviceBlocked` | `src/common/internalEvents.ts` | Replaced by socket-api `socketAPIDeviceDisabled` → `onDeviceDisabled` |
| `mxdbUserAuthenticated` | `src/common/internalEvents.ts` | Replaced by socket-api `socketAPIUserChanged` → `onSignedIn` |
| `mxdbSignOutAction` | `src/common/internalActions.ts` | Sign-out now via socket-api `POST /signout`; no socket action needed |

`mxdbServerToClientSyncAction` is kept — it is unrelated to auth.

---

## 12. Dev Bypass

The old bypass injected a token into `socket.auth`. The new bypass issues a real HttpOnly cookie so the standard auth path is exercised.

### Server (non-production only)

Add `src/server/auth/registerDevAuthRoute.ts`:

```ts
// POST /{name}/dev/signin   — guard: NODE_ENV !== 'production'
// Body: { userId: string }
// Creates/updates a WebAuthnAuthRecord with keyHash = DEV_BYPASS_KEY_HASH sentinel
// Sets socketapi_session cookie
// Returns { userId }
```

Registered in `startAuthenticatedServer` when `process.env.NODE_ENV !== 'production'`.

### Client

`src/client/utils/setupBrowserTools.ts` gains a `setDevAuth(userId)` function:

```ts
window.mxdb.setDevAuth = async (userId: string) => {
  const res = await fetch(`/${name}/dev/signin`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new Error('Dev auth failed');
  localStorage.setItem(`mxdb:dev-auth:${name}`, JSON.stringify({ userId }));
  location.reload(); // reload so MXDBSyncInner picks up the cookie
};
```

### `MXDBSyncInner` dev bypass path

On mount, before triggering any WebAuthn ceremony, `MXDBSyncInner` checks `localStorage` for a dev auth entry. If found:
- Skip `signIn()` entirely
- Use `new Uint8Array(32).fill(0xde)` as the encryption key
- Use the stored `userId` as the db name
- Clear the localStorage entry after reading (it was only needed to survive the reload)

This path is stripped from production builds via `process.env.NODE_ENV` guards.

---

## 13. Error Handling

- WebAuthn ceremony failure (user cancels passkey) — `signIn()` rejects; `MXDBSyncInner` catches and calls `onError({ code: 'AUTH_FAILED', ... })`.
- Reauth route 401 (device disabled between page load and reauth) — mxdb-sync treats this the same as `onDeviceDisabled`.
- Cookie missing on connect — socket-api's `validateSessionCookie` disconnects; `MXDBSyncInner` sees no `onSignedIn` and stays in unauthenticated state.

---

## 14. Testing

- `useMXDBSync` rename: update all test usages of `testDisconnect`/`testReconnect`.
- E2E sync tests (`tests/e2e/setup/syncClient.tsx`): dev bypass path must work; the `setDevAuth` utility is called in test setup instead of the old localStorage injection.
- Unit tests: `AuthCollection` tests updated for new field/method names.
- Integration: `startAuthenticatedServer` tests updated to use `configureAuthentication` mock.

---

## Summary of Files

### Deleted
- `src/client/auth/AuthProvider.tsx`
- `src/client/auth/TokenProvider.tsx`
- `src/client/auth/SocketProvider.tsx`
- `src/client/auth/IndexedDbProvider.tsx`
- `src/client/auth/IndexedDbContext.ts`
- `src/client/auth/IndexedDbAuthStore.ts`
- `src/client/auth/AuthContext.ts`
- `src/client/auth/deriveEncryptionKey.ts`
- `src/server/auth/registerAuthInviteRoute.ts`
- `src/server/auth/TokenRotation.ts`

### Added
- `src/client/auth/deriveKey.ts`
- `src/client/auth/MXDBSyncInner.tsx`
- `src/server/auth/registerDevAuthRoute.ts`

### Modified (significant)
- `src/client/MXDBSync.tsx`
- `src/client/useMXDBSync.ts`
- `src/client/auth/AuthContext.ts`
- `src/server/startAuthenticatedServer.ts`
- `src/server/auth/AuthCollection.ts`
- `src/server/auth/authConfig.ts`
- `src/server/auth/useAuth.ts`
- `src/common/internalEvents.ts`
- `src/common/internalActions.ts`

### Modified (minor — rename only)
- `test/client/ConnectionTest.tsx`
- `tests/e2e/setup/syncClient.tsx`
- `README.md`
- `docs/guides/client-guide.md`
