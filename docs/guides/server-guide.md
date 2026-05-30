# Server guide

How to run **@anupheaus/mxdb** on **Node** with **MongoDB** and **nexus**. This matches **`startServer`** → **`startAuthenticatedServer`** and **`provideDb`**.

---

## 1. Install and import

```ts
import { startServer } from '@anupheaus/mxdb/server';
import { defineCollection } from '@anupheaus/mxdb/common';
```

Use the **same** `defineCollection()` definitions as the client (shared module recommended).

---

## 2. `startServer(config)`

**`ServerConfig`** (see [`src/server/internalModels.ts`](../../src/server/internalModels.ts)) extends nexus’s server config. Notable fields:

| Field | Purpose |
|-------|---------|
| `mongoDbUrl`, `mongoDbName` | Mongo connection |
| `collections` | `MXDBCollection[]` from `defineCollection` |
| `name` | App name (invite routes, logging) |
| `logger` | Optional |
| `shouldSeedCollections` | Run seed pipeline when true |
| `clearDatabase` | Dangerous reset (optional) |
| `changeStreamDebounceMs` | Batch change-stream notifications (default ~20ms) |
| `onGetUserDetails(userId)` | **Required** for auth — return user details for invite/device flows |
| `inviteLinkTTLMs` | Invite link lifetime (default 24h) |
| `onRegisterRoutes(router)` | Add your HTTP routes (Koa router); auth invite route is registered automatically |

**Return value (`ServerInstance`):**

- **`app`** — Koa app (mount or listen as you prefer)
- **`createInvite`** (WebAuthn mode only), **`getDevices`**, **`enableDevice`**, **`disableDevice`**, **`deleteDevice`** — device / invite management on the instance
- **`useAuthDevices()`** — same operations as a hook inside socket actions and HTTP routes after `startServer` (`listForUser`, `createInvite`, `setEnabled`, `deleteDevice`, `expireStalePendingInvites`)

Internally: **`provideDb`** opens Mongo + change streams, then **`startAuthenticatedServer`** starts the socket server with **internal actions** and **subscriptions**, per-socket **`ServerToClientSynchronisation`** (registered before auth awaits complete), and **client DB watches**.

---

## 3. Socket actions registered by default

From [`src/server/actions/internalActions.ts`](../../src/server/actions/internalActions.ts):

| Handler | Action |
|---------|--------|
| **`clientToServerSyncAction`** | **`mxdbClientToServerSyncAction`** — merge/replay client audit slices, persist, seed S2C mirror |
| **`serverGetAction`** | **`mxdbGetAction`** |
| **`serverQueryAction`** | **`mxdbQueryAction`** |
| **`serverDistinctAction`** | **`mxdbDistinctAction`** |

**Subscriptions** (query, distinct, get-all) live under **`src/server/subscriptions/`**.

**S2C:** The server invokes **`mxdbServerToClientSyncAction`** with a payload and **awaits** the client **ack** (typed action with response). Emission is typically through **`ServerToClientSynchronisation`** + **`useAction`** in connection scope.

---

## 4. Using collections on the server

Inside a **socket action or subscription** handler (async context provided by nexus + MXDB **`useDb`**):

```ts
import { useCollection } from '@anupheaus/mxdb/server';
// const { collection, upsert, query, ... } = useCollection(myCollection);
```

See [`src/server/collections/useCollection.ts`](../../src/server/collections/useCollection.ts) for the exact surface (`get`, `getAudit`, `upsert`, `remove`, `query`, `onChange`, …).

---

## 5. Extending the server

- **`actions`** — append custom **`SocketAPIServerAction`** handlers to the array passed into **`startAuthenticatedServer`** (merged with internal list).
- **`subscriptions`** — same for subscriptions.
- **`onClientConnected`**, **`onClientDisconnected`** — lifecycle hooks (watches + S2C instance are already set up around these).

---

## 6. Seeding

With **`shouldSeedCollections: true`**, **`seedCollections`** runs on startup (admin impersonation context). Implement seed data per your product; see **`src/server/seeding/`**.

---

## 7. C2S / S2C behaviour

Normative documentation:

- [client-to-server-synchronisation.md](../plans/client-to-server-synchronisation.md)
- [server-to-client-synchronisation.md](../plans/server-to-client-synchronisation.md)

Key implementation files:

- [`src/server/actions/clientToServerSyncAction.ts`](../../src/server/actions/clientToServerSyncAction.ts)
- [`src/server/ServerToClientSynchronisation.ts`](../../src/server/ServerToClientSynchronisation.ts)
- [`src/server/clientDbWatches.ts`](../../src/server/clientDbWatches.ts)

---

## 8. Feature index

See [reference/features.md](../reference/features.md).
