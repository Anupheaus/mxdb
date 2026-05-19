# MXDB

[![CI](https://github.com/Anupheaus/mxdb/actions/workflows/ci.yml/badge.svg)](https://github.com/Anupheaus/mxdb/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@anupheaus/mxdb.svg)](https://www.npmjs.com/package/@anupheaus/mxdb)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

MXDB syncs MongoDB-backed collections with clients over a real-time connection (Socket.IO). You define collections once in shared code, use them on the client with React hooks and local SQLite storage, and on the server with actions, subscriptions, and lifecycle hooks. Authentication uses WebAuthn (PRF extension) and a server-managed invite-link flow.

## Documentation

Full documentation lives in **`docs/`** in this repo and is **included in the npm package** (so it appears under `node_modules/@anupheaus/mxdb/docs/` after install).

| Start here | Purpose |
|------------|---------|
| **[docs/README.md](docs/README.md)** | Index: guides, reference, plans, archive |
| **[docs/guides/client-guide.md](docs/guides/client-guide.md)** | React: `MXDBSync`, hooks, auth, sync |
| **[docs/guides/server-guide.md](docs/guides/server-guide.md)** | Node: `startServer`, MongoDB, extensions |
| **[docs/reference/tech-overview.md](docs/reference/tech-overview.md)** | Architecture & data-flow diagrams |
| **[docs/reference/features.md](docs/reference/features.md)** | API map: actions, events, subscriptions |

Deeper design and sync specifications: **`docs/plans/`** (see the index in **`docs/README.md`**).

**[Sync Engine](src/common/sync-engine/AGENTS.md)** — living reference for the four-component sync protocol (ClientDispatcher, ServerReceiver, ServerDispatcher, ClientReceiver).

**[AGENTS.md](AGENTS.md)** (repo root) — short orientation for contributors and AI assistants.

## Package exports

- **`@anupheaus/mxdb/common`** – Shared types and collection definitions.
- **`@anupheaus/mxdb/server`** – Server startup, collections API, and extension hooks.
- **`@anupheaus/mxdb/client`** – React provider, hooks, and sync.

## Architecture

The library is split into three layers:

| Layer | Role |
|-------|------|
| **Common** | Define collections with `defineCollection(config)`. Config includes `name`, `indexes`, `syncMode`, and `disableAudit`. Shared by client and server. |
| **Client** | Wrap the app in `<MXDBSync>`, then use `useCollection(collection)` for CRUD and real-time updates. Auth hooks (`useMXDBAuth`, `useMXDBInvite`, `useMXDBSignOut`) manage WebAuthn device registration and sessions. `useRecord()` provides optimistic edit + server-rebase semantics. |
| **Server** | Call `startServer(config)` with MongoDB connection, collections, and an `onGetUserDetails` callback. Use `extendCollection(collection, hooks)` to add lifecycle hooks and seeding. The returned `ServerInstance` exposes invite-link and device-management helpers. |

The server exposes socket actions (upsert, remove, get, getAll, query, distinct, sync) and subscriptions; the client talks to them over the socket and stores data locally in a per-device SQLite database. Change notifications are driven by the MongoDB change stream.

## Defining collections

```ts
import { defineCollection } from '@anupheaus/mxdb/common';

export const products = defineCollection<Product>({
  name: 'products',
  indexes: [
    { name: 'by-name', fields: ['name'], isUnique: true },
  ],
  syncMode: 'Synchronised', // default — see below
  disableAudit: false,       // default
});
```

**`MXDBCollectionConfig` options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | — | Unique collection name (must match on client and server). |
| `indexes` | `MXDBCollectionIndex[]` | — | MongoDB / SQLite indexes. Each has `name`, `fields` (dot-notation paths), `isUnique?`, `isSparse?`. |
| `syncMode` | `'Synchronised' \| 'ServerOnly' \| 'ClientOnly'` | `'Synchronised'` | `Synchronised` — exists on both, kept in sync. `ServerOnly` — no client-side storage. `ClientOnly` — no server-side storage. |
| `disableAudit` | `boolean` | `false` | When `true`, no audit trail is maintained and sync uses last-write-wins by timestamp instead of ULID-ordered audit entries. |

## Server setup

```ts
import { startServer } from '@anupheaus/mxdb/server';
import { collections } from './collections';
import './configureExtensions'; // extendCollection(...)

const instance = await startServer({
  name: 'my-app',
  logger,
  collections,
  server: httpServer,
  mongoDbName: 'mydb',
  mongoDbUrl: process.env.MONGO_URI,
  onGetUserDetails: async (userId) => myDb.getUserById(userId),
  shouldSeedCollections: true,
  changeStreamDebounceMs: 20,
  inviteLinkTTLMs: 24 * 60 * 60 * 1000,
});
```

**`ServerConfig` options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `collections` | `MXDBCollection[]` | ✓ | Collections returned from `defineCollection()`. |
| `mongoDbUrl` | `string` | ✓ | MongoDB connection URI. |
| `mongoDbName` | `string` | ✓ | Database name. |
| `onGetUserDetails` | `(userId: string) => Promise<MXDBUserDetails>` | ✓ | Called during invite redemption to fetch user details. |
| `server` | HTTP/HTTPS/HTTP2 server | ✓ | Node HTTP server to attach the socket to. |
| `name` | `string` | ✓ | App name — used in invite-link routes (`/<name>/register`). |
| `shouldSeedCollections` | `boolean` | | If true, runs `onSeed` hooks at startup. |
| `changeStreamDebounceMs` | `number` | | Idle window (ms) before change-stream events are dispatched; events within the window are batched. Default `20`. |
| `inviteLinkTTLMs` | `number` | | Invite link lifetime in ms. Default `86 400 000` (24 h). |
| `clearDatabase` | `boolean` | | Drops and re-creates all collections on startup. **Destructive.** |

Additional props (`actions`, `subscriptions`, `onStartup`, `onClientConnected`, `onClientDisconnected`, `onRegisterRoutes`, …) are passed through to the underlying socket server.

**`ServerInstance`** (the resolved value):

```ts
interface ServerInstance {
  app: Koa;
  createInvite(userId: string, baseUrl: string): Promise<string>;
  getDevices(userId: string): Promise<MXDBDeviceInfo[]>;
  enableDevice(requestId: string): Promise<void>;
  disableDevice(requestId: string): Promise<void>;
  close(): Promise<void>;
}
```

Use `createInvite` to generate a time-limited URL you can send to a user. They open it in the browser, the client calls `useMXDBInvite()(url)`, WebAuthn registers a new device, and the device receives an auth token. Use `getDevices` / `enableDevice` / `disableDevice` to manage registered devices per user.

## Client setup

```tsx
import { MXDBSync, useCollection, useMXDB } from '@anupheaus/mxdb/client';
import { products } from './collections';

function App() {
  return (
    <MXDBSync
      name="my-app"
      collections={[products]}
      host="wss://my-server"
      onError={err => console.error(err.code, err.message)}
      onConflictResolution={async msg => window.confirm(msg)}
    >
      <Content />
    </MXDBSync>
  );
}

function Content() {
  const { get, getAll, upsert, remove, query, find, distinct,
          useGet, useGetAll, useQuery, useDistinct,
          useSubscription, tableRequest, onChange } = useCollection(products);
  const { isConnected, clientId, isSynchronising } = useMXDB();
  // ...
}
```

**`MXDBSync` props:**

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `name` | `string` | ✓ | Must match the `name` passed to `startServer`. |
| `collections` | `MXDBCollection[]` | ✓ | Collections to open locally. |
| `host` | `string` | | WebSocket server URL. Must use `wss://`. Omit to connect to the same origin. |
| `logger` | `Logger` | | Logger instance for diagnostics. |
| `onError` | `(error: MXDBError) => void` | | Called for non-auth errors (`SYNC_FAILED`, `TIMEOUT`, `DB_NOT_OPEN`, etc.). |
| `onConflictResolution` | `(message: string) => Promise<boolean>` | | Called when a server-side deletion conflicts with a locally-edited record. Return `true` to restore the record, `false` to accept the deletion. |
| `onInvalidToken` | `() => Promise<void>` | | Called when the stored auth token is rejected. Use to trigger re-authentication. |
| `onUnauthorisedOperation` | `() => Promise<UnauthorisedOperationDetails>` | | Called when an operation is rejected as unauthorised. |

**`useCollection(collection)`** returns:

`get`, `getAll`, `upsert`, `remove`, `query`, `find`, `distinct` — imperative async operations.

`useGet`, `useGetAll`, `useQuery`, `useDistinct`, `useSubscription` — reactive hooks (subscribe to live updates).

`tableRequest`, `onChange`, `config` — utilities.

**`useMXDB()`** returns:

| Property | Description |
|----------|-------------|
| `isConnected` | Whether the socket is currently connected. |
| `clientId` | The socket ID of this client, or `undefined` when disconnected. |
| `isSynchronising` | Whether a sync operation is in progress. |
| `onConnectionStateChanged` | Subscribe to connection state changes. |
| `testDisconnect` / `testReconnect` | Force disconnect/reconnect for testing. |

## Authentication

Authentication is device-scoped and uses **WebAuthn with the PRF extension** to derive a per-device encryption key. Devices are registered via an invite-link flow; there is no username/password.

```tsx
import { useMXDBAuth, useMXDBInvite, useMXDBSignOut } from '@anupheaus/mxdb/client';

// Check whether the current device is authenticated
const { isAuthenticated } = useMXDBAuth();

// Redeem an invite link (triggers WebAuthn credential creation)
const handleInvite = useMXDBInvite();
await handleInvite(inviteUrl, { appName: 'My App' });
// → creates WebAuthn credential, registers device on server, stores token locally

// Sign out of the current device
const { signOut } = useMXDBSignOut();
await signOut();
```

**Flow:**
1. Server calls `instance.createInviteLink(userId, domain)` and sends the URL to the user.
2. Client calls `useMXDBInvite()(url)` — opens a WebAuthn prompt, registers a credential with the PRF extension, and exchanges a registration token with the server.
3. The server calls `onGetUserDetails(userId)` to associate the new device with user data and issues an auth token.
4. The token is stored encrypted in IndexedDB; `MXDBSync` uses it on subsequent loads.
5. Token rotation happens automatically in the background.

## `useRecord`

`useRecord` is a convenience hook for form-style editing. It keeps a working copy of a record, rebases local edits onto server updates, and handles server-side deletion conflicts via `onConflictResolution`.

```tsx
import { useRecord } from '@anupheaus/mxdb/client';

// Read-only (tracks live DB record)
const { record, isLoading, upsert, remove } = useRecord(id, products);

// Edit mode (pass a mutable copy — useRecord rebases server changes onto it)
const { record } = useRecord(localCopy, products);
```

## Extending collections (server)

Use `extendCollection(collection, hooks)` on the server to add lifecycle hooks and seeding.

```ts
import { extendCollection } from '@anupheaus/mxdb/server';

extendCollection(products, {
  onBeforeUpsert: async ({ records }) => { /* validate */ },
  onAfterUpsert:  async ({ records }) => { /* cascade updates */ },
  onBeforeDelete: async ({ recordIds }) => { /* validate */ },
  onAfterDelete:  async ({ recordIds }) => { /* cascade deletes */ },
  onBeforeClear:  async ({ collectionName }) => { /* pre-clear side effects */ },
  onAfterClear:   async ({ collectionName }) => { /* post-clear side effects */ },
  onSeed: async seedWith => {
    await seedWith({ count: 10, create: () => ({ id: ulid(), name: '' }) });
  },
});
```

**Hook semantics:**

| Hook | When it runs |
|------|-------------|
| `onBefore*` | Runs on the server instance that handles the request, **before** the write. Use for validation or pre-write side effects. |
| `onAfter*` (upsert/delete) | Driven by the **MongoDB change stream** — runs on every instance watching the stream, including when another instance performed the write. Use for cross-collection cascades. |
| `onAfterClear` | Runs only on the instance that performed the clear (not currently change-stream driven). |
| `onSeed` | Runs at startup when `shouldSeedCollections: true`. |

Clients are notified only **after** `onAfterUpsert` / `onAfterDelete` for that change have completed.

**`seedWith` options:**

| Option | Description |
|--------|-------------|
| `count` | Minimum number of records to ensure exist. |
| `create()` | Factory function called to create each missing record. |
| `fixedRecords` | Specific records to upsert unconditionally. |
| `validate(record)` | Optional — return a modified record, `true` to keep, or `false`/`void` to skip. |

## Change stream and notification order

Change-stream events are batched per collection. After no events have arrived for `changeStreamDebounceMs` (default 20 ms), the batch is dispatched: `onAfter` hooks run first, then connected clients are notified.

When an `onAfter` hook writes to **another** collection, that write produces a separate change-stream event batched independently. There is no cross-collection ordering guarantee — clients may briefly see a deleted record's reference intact in a related collection until the cascade-update notification arrives.

## Conflict resolution

The only mechanism is **ULID-ordered last-write-wins** on the audit entry. The audit entry with the highest ULID wins; record fields have no effect on conflict resolution. When `disableAudit: true`, last-write-wins by timestamp is used instead.

**Deletion and restoration:** an `Updated` entry with a higher ULID than a `Deleted` entry does **not** restore the record. Restoration requires an explicit `Restored` audit entry. There is no automatic restoration pathway.

## Development

```sh
pnpm build          # production build
pnpm start          # development build (watch)
pnpm test           # unit tests (src/ + *.unit.tests)
pnpm test:crud      # CRUD e2e tests
pnpm test:performance  # performance e2e tests
pnpm test:stress    # stress / data-integrity tests
```

See **[tests/e2e/stress/README.md](tests/e2e/stress/README.md)** for a detailed explanation of how the stress tests work.

## License

Apache-2.0
