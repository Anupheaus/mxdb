# Features & public API reference

This page maps **what the repo provides** to **where it lives** and **how it is used**. It reflects the current **`src/`** layout; for integration steps see [client-guide.md](../guides/client-guide.md) and [server-guide.md](../guides/server-guide.md).

---

## Package exports

| Import | Typical use |
|--------|-------------|
| `@anupheaus/mxdb/client` | Browser / React app |
| `@anupheaus/mxdb/server` | Node server |
| `@anupheaus/mxdb/common` | Shared collection definitions and types (imported by both sides) |

---

## Common layer (`/common`)

| Feature | What it does | Main symbols / paths |
|---------|----------------|----------------------|
| **Collection definition** | Register a typed collection name + config (sync mode, schema hooks, etc.) | `defineCollection` — [`src/common/defineCollection.ts`](../../src/common/defineCollection.ts) |
| **Config registry** | Lookup collection config at runtime | `configRegistry` — [`src/common/registries.ts`](../../src/common/registries.ts) |
| **Models** | Wire types for sync, auth, queries | [`src/common/models/`](../../src/common/models/) |
| **Auditor** | Audit trail merge, replay, hashes, `hasPendingChanges`, etc. | [`src/common/auditor/`](../../src/common/auditor/) — re-exported from `common` |
| **Socket actions (symbols)** | Typed names for client↔server RPC | [`src/common/internalActions.ts`](../../src/common/internalActions.ts) |
| **Socket events (symbols)** | Typed names for server→client pushes (no request/response pair) | [`src/common/internalEvents.ts`](../../src/common/internalEvents.ts) |
| **Subscriptions (symbols)** | Long-lived query / distinct / get-all streams | [`src/common/internalSubscriptions.ts`](../../src/common/internalSubscriptions.ts) |

### Actions vs events (nexus)

- **`defineAction<Request, Response>`** — RPC: caller sends a request and awaits a typed response. Used for **C2S sync**, **S2C sync** (server uses **`useAction`** to call the **client** handler and await **ack** — client registers **`useServerActionHandler`**), and **get / getAll / query / distinct** actions.
- **`defineEvent<Payload>`** — One-way push with payload only. In this repo: **legacy** `mxdbServerPush`, **`mxdbRefreshQuery`**, **`mxdbTokenRotated`**.

**Symbols in** [`src/common/internalActions.ts`](../../src/common/internalActions.ts): **`mxdbClientToServerSyncAction`**, **`mxdbServerToClientSyncAction`**, **`mxdbGetAction`**, **`mxdbGetAllAction`**, **`mxdbQueryAction`**, **`mxdbDistinctAction`**.

**Handlers registered** on the default server ([`src/server/actions/internalActions.ts`](../../src/server/actions/internalActions.ts)): **C2S sync**, **get**, **getAll**, **query**, **distinct**. **`getAll`** (and **`useGetAll`**) use **`mxdbGetAllAction`** plus **`mxdbGetAllSubscription`** so the client can hydrate and receive updates like **query** / **distinct**.

Legacy **`mxdbSyncCollectionsAction`**, **`mxdbUpsertAction`**, **`mxdbRemoveAction`** are **not** part of the current default server registration; normal writes go through **C2S** + local **`enqueue`**.

---

## Client layer (`/client`)

| Feature | What it does | Main entry |
|---------|----------------|------------|
| **Root provider** | Logger, conflict resolution context, IndexedDB auth bridge | `MXDBSync` — [`src/client/MXDBSync.tsx`](../../src/client/MXDBSync.tsx) |
| **Connection + sync UI state** | `isConnected`, `clientId`, optional test disconnect/reconnect, sync spinner hook-up | `useMXDB` — [`src/client/useMXDB.ts`](../../src/client/useMXDB.ts) |
| **Single-record hook** | Load / edit one record with rebase-on-push behaviour | `useRecord` — [`src/client/useRecord.ts`](../../src/client/useRecord.ts) |
| **Collection hook** | `get`, `useGet`, `getAll`, `useGetAll`, `upsert`, `remove`, `query`, `useQuery`, `distinct`, `useDistinct`, `onChange`, … | `useCollection` — [`src/client/hooks/useCollection/useCollection.ts`](../../src/client/hooks/useCollection/useCollection.ts) |
| **Auth** | Whether IndexedDB session is ready | `useMXDBAuth` — [`src/client/hooks/useMXDBAuth.ts`](../../src/client/hooks/useMXDBAuth.ts) |
| **Invite / registration** | Invite flow helpers | `useMXDBInvite` — [`src/client/hooks/useMXDBInvite.ts`](../../src/client/hooks/useMXDBInvite.ts) |
| **Sign out** | Clear local session | `useMXDBSignOut` — [`src/client/hooks/useMXDBSignOut.ts`](../../src/client/hooks/useMXDBSignOut.ts) |

### Internal providers (composed under `MXDBSync`)

| Area | Role |
|------|------|
| **`IndexedDbBridge`** | WebAuthn PRF → encryption key, auth token, `SocketAPI`, `DbsProvider`, C2S/S2C providers |
| **`DbsProvider` / SQLite worker** | Encrypted local DB per user |
| **`ClientToServerSyncProvider`** | One **`ClientToServerSynchronisation`** per mount; connection + debounced **`mxdbClientToServerSyncAction`** |
| **`ClientToServerProvider`** | Wires **`enqueue`** from local **`DbCollection`** changes |
| **`ServerToClientProvider`** | **`useServerActionHandler(mxdbServerToClientSyncAction)`** — applies S2C payload, returns **ack** (and legacy **`useEvent(mxdbServerPush)`**) |
| **`SyncProvider`**, **`TokenRotationProvider`** | Legacy sync + token rotation |

---

## Server layer (`/server`)

| Feature | What it does | Main entry |
|---------|----------------|------------|
| **Start API** | MongoDB + socket server + auth invite route + internal actions | `startServer` — [`src/server/startServer.ts`](../../src/server/startServer.ts) |
| **Authenticated socket stack** | Per-socket **`ServerToClientSynchronisation`**, token rotation gate, client DB watches | [`src/server/startAuthenticatedServer.ts`](../../src/server/startAuthenticatedServer.ts) |
| **DB provider** | `ServerDb`, change streams, collection CRUD + audit | [`src/server/providers/`](../../src/server/providers/) |
| **C2S handler** | **`mxdbClientToServerSyncAction`** — merge/replay/persist + mirror seed | [`src/server/actions/clientToServerSyncAction.ts`](../../src/server/actions/clientToServerSyncAction.ts) |
| **Query / get / distinct** | Standard CRUD/query actions | [`src/server/actions/`](../../src/server/actions/) |
| **Subscriptions** | Query, distinct, and get-all subscriptions | [`src/server/subscriptions/`](../../src/server/subscriptions/) |
| **Seeding** | Optional collection seed on startup | [`src/server/seeding/`](../../src/server/seeding/) |
| **Auth helpers** | Invite links, device list, enable/disable/delete device, stale-invite cleanup | **`useAuthDevices()`** after **`startServer`**; legacy helpers on **`ServerInstance`** (`createInvite`, `getDevices`, `deleteDevice`, …) |

### Server collection hook

| Feature | Path |
|---------|------|
| **`useCollection`** (server) | [`src/server/collections/useCollection.ts`](../../src/server/collections/useCollection.ts) — typed access to **`ServerDb`** collection inside connection/async context |

---

## Tests

| Area | Path |
|------|------|
| Multi-client integration | [`tests/sync-test/`](../../tests/sync-test/) |
| Unit tests | Colocated `*.test.ts` under `src/` |
