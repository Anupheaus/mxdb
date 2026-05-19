# Client guide

How to integrate **@anupheaus/mxdb-sync** in a **React** app. This matches the current **`src/client`** wiring (IndexedDB auth, SQLite in a worker, nexus).

---

## 1. Install and import

```ts
import { MXDBSync, useCollection, useMXDB, useRecord } from '@anupheaus/mxdb-sync/client';
import { defineCollection } from '@anupheaus/mxdb-sync/common';
```

Define collections in **common** (or a shared package) so the **same** `MXDBCollection` tokens are used on server and client.

---

## 2. Mount `MXDBSync`

`MXDBSync` is the root provider. It:

- Enforces **`wss://`** only when `host` is set (plain **`ws://`** throws).
- Wraps children with logger + **conflict resolution** context.
- Renders **`IndexedDbBridge`**, which loads auth from IndexedDB, derives encryption (WebAuthn PRF when available), opens **encrypted SQLite**, and connects **SocketAPI**.

**Typical props:**

| Prop | Purpose |
|------|---------|
| `host` | Socket API URL (**`wss://…`**) |
| `name` | App / tenant name (used in auth + routing) |
| `collections` | Array from `defineCollection()` |
| `logger` | Optional `Logger` |
| `onError` | **`MXDBError`** reporting |
| `onInvalidToken` | Refresh or sign-out when token is invalid |
| `onUnauthorisedOperation` | Optional extra auth UX |
| `onConflictResolution` | When a **root-record deletion** conflicts with local state — return `true` to keep local, `false` to accept delete |

Children render **inside** authenticated DB + socket once the bridge has finished loading.

---

## 3. Auth and “ready” state

- **`useMXDBAuth()`** → `{ isAuthenticated }` — `true` when IndexedDB session is loaded and SQLite is open (see `AuthTokenContext`).
- Registration / invite flows use **`useMXDBInvite`**; sign-out uses **`useMXDBSignOut`**.

Details of WebAuthn + PRF are documented in [design.md](../plans/design.md) (platform section); the client code paths live under **`src/client/auth/`**.

---

## 4. Local database and `useDb`

`DbsProvider` (inside the bridge) exposes the SQLite-backed **`db`**. Hooks such as **`useCollection`** call **`useDb()`** internally. You normally **do not** mount `DbsProvider` yourself unless you build a custom stack.

---

## 5. `useCollection(collection)`

Returns CRUD + query API bound to one collection:

- **`get`**, **`useGet`**, **`getAll`**, **`useGetAll`**
- **`upsert`**, **`remove`**
- **`query`**, **`useQuery`**, **`useSubscription`**
- **`distinct`**, **`useDistinct`**

**`useGetAll`** behaves like **`useQuery`** / **`useDistinct`**: it keeps a subscription while mounted so the list refreshes when the server pushes changes (and still uses the local DB when offline).
- **`find`**, **`onChange`**

**`ServerOnly`** collections **throw** if used on the client (see `config.syncMode`).

Local mutations go through **`DbCollection`**, which **`ClientToServerProvider`** turns into **`ClientToServerSynchronisation.enqueue`** (debounced **`mxdbClientToServerSyncAction`**). You do **not** call upsert/remove socket actions directly for normal edits.

---

## 6. `useRecord` and editing

**`useRecord(recordOrId, collection)`** combines **`useGet`** + **`upsert`**/**`remove`** and handles **rebase** when the server pushes while the user is editing. Pass either an **id** or a **record object** (editing mode).

---

## 7. Connection and sync UI

**`useMXDB()`** exposes:

- **`isConnected`**, **`clientId`**
- **`onConnectionStateChanged`** (from nexus)
- **`disconnect`**, **`connect`** (testing helpers)
- **`isSynchronising`** — tracks sync state via **`SyncStateContext`**

**`ClientToServerSyncProvider`** wires **`onConnectionStateChanged`** into **`ClientToServerSynchronisation.setConnected`** and **closes** the synchroniser on unmount.

---

## 8. Server → client updates

**`ServerToClientProvider`** registers **`useServerActionHandler(mxdbServerToClientSyncAction)`** (server-initiated **action** with ack): it **awaits** the C2S “phase B” gate (`waitForS2CGate`) before applying payloads, then returns the **ack** so the server can update its mirror.

Legacy **`mxdbServerPush`** is still wired with **`useEvent`** for migration.

---

## 9. Specs vs code

Behavioural details (debounce, mirror queue, idempotent C2S, etc.) are in:

- [client-to-server-synchronisation.md](../plans/client-to-server-synchronisation.md)
- [server-to-client-synchronisation.md](../plans/server-to-client-synchronisation.md)

---

## 10. Feature index

See [reference/features.md](../reference/features.md) for a full symbol map.
