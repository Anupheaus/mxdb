# Server layer (`src/server/`)

`startServer`, MongoDB persistence, server-side sync, WebAuthn auth, lifecycle hooks.

## Overview

Exposes one public function (`startServer`) and one composable extension hook (`extendCollection`). Internally it wires Socket.IO actions/subscriptions, a MongoDB persistence layer, change-stream-driven S2C notifications, and a WebAuthn/invite-link auth flow.

## Contents

### Entry points
- `startServer.ts` — `startServer(config)` — main async init; connects to MongoDB, starts socket server, returns `ServerInstance`
- `startAuthenticatedServer.ts` — inner bootstrap called by `startServer`; wires auth namespace, socket actions, and Koa. Registers per-socket S2C **before** auth `await`s so C2S handlers never hit a no-op S2C fallback during connect.
- `index.ts` exports — `useAuthDevices()` for invite/device admin inside socket actions and HTTP routes (after `startServer`)

### Collections API (`collections/`)
`extendCollection` (lifecycle hooks + seeding) and `useCollection` (server-side collection accessor). See [collections/AGENTS.md](collections/AGENTS.md).

### Socket actions (`actions/`)
Handlers for C2S socket calls: `get`, `getAll`, `query`, `distinct`, `clientToServerSync`, `reconcile`. See [actions/AGENTS.md](actions/AGENTS.md).

### Subscriptions (`subscriptions/`)
Server-side reactive subscriptions: `getAll`, `query`, `distinct`. See [subscriptions/AGENTS.md](subscriptions/AGENTS.md).

### MongoDB persistence (`providers/db/`)
`ServerDb`, `ServerDbCollection`, change stream, `DbContext`. See [providers/db/AGENTS.md](providers/db/AGENTS.md).

### Auth (`auth/`)
Auth strategy classes (WebAuthn, Google OAuth), invite-link handshake, device management, and context hook. See [auth/AGENTS.md](auth/AGENTS.md).

### Audit (`audit/`)
- `toServerAuditOf.ts` — promotes a client `AuditOf` to `ServerAuditOf` by adding `socketId`, `timestamp`

### Hooks (`hooks/`)
See [hooks/AGENTS.md](hooks/AGENTS.md) for the full directory. Key exports:
- `createUseRecord(name, collection, options)` — factory: returns an async function for loading, hydrating, and mutating a single record.
- `createUseRecords(name, collection, options?)` — factory: returns a sync function for collection method access plus an async `.query()` helper.
- `useAuditor()` — auditor helpers for the current socket context
- `useClient()` — client id and user id for the current socket context

### S2C synchronisation
- `ServerToClientSynchronisation.ts` — per-socket `ServerDispatcher` lifecycle; receives change-stream events and pushes S2C cursors to connected clients

### Seeding (`seeding/`)
- `seedCollections.ts` — called at startup when `shouldSeedCollections: true`; runs `onSeed` hooks
- `seededData.ts` — tracks seeded record ids to prevent duplicate seeding across restarts

### Utilities / internal
- `subscriptionDataStore.ts` — per-client key-value store used by subscriptions to track prior data (e.g. previous record ids for getAll diffs)
- `clientDbWatches.ts` — tracks which clients are subscribed to which collections
- `internalModels.ts` — `ServerConfig` and `ServerInstance` type definitions

### Remote MCP (admin / AI integration)

The server exposes a minimal MCP-over-HTTP endpoint intended for remote assistance and diagnostics.

- **Route**: `POST /mcp` (JSON-RPC 2.0), `GET /mcp` (stub; SSE not supported yet)
- **Auth** (deny-by-default): both required
  - `MXDB_MCP_API_KEY` — API key value checked against `Authorization: Bearer <key>`
  - `MXDB_MCP_IP_ALLOWLIST` — comma-separated IPv4/CIDR allowlist (e.g. `1.2.3.4/32,10.0.0.0/24`)
- **Tools**
  - `mxdb_clients_list` — list connected clients (`socketId`, `userId?`, `accountId?`)
  - `mxdb_client_sqlite_query` — forward a SQL query to a specific connected client (by `socketId`) and return results

Implementation lives under `src/server/mcp/`.

## Architecture

`startServer` wires everything in order:
1. `provideDb` — connects MongoDB, opens `ServerDb`, starts change stream
2. `startAuthenticatedServer` — starts Socket.IO, registers auth namespace, mounts actions and subscriptions
3. Per-socket: `ServerReceiver` + `ServerDispatcher` created on connect, destroyed on disconnect

## Ambiguities and gotchas

- **`onAfterUpsert` / `onAfterDelete` are change-stream driven** — they run on every server instance watching the stream, not just the one that originated the write. Use `onBefore*` for per-request validation.
- **`registerDevAuthRoute` is excluded in production** — do not rely on it in prod builds.
- **`close()` on `ServerInstance`** terminates the MongoDB connection. Required for clean test teardown; neglecting it causes open handle warnings in Vitest.

## Related

- [auth/AGENTS.md](auth/AGENTS.md) — WebAuthn / Google OAuth strategies, invite-link flow, device management
- [hooks/AGENTS.md](hooks/AGENTS.md) — server hooks (createUseRecord, createUseRecords, useAuditor, useClient)
- [collections/AGENTS.md](collections/AGENTS.md) — extendCollection and useCollection
- [actions/AGENTS.md](actions/AGENTS.md) — socket action handlers
- [subscriptions/AGENTS.md](subscriptions/AGENTS.md) — server-side subscriptions
- [providers/db/AGENTS.md](providers/db/AGENTS.md) — MongoDB persistence
- [../common/AGENTS.md](../common/AGENTS.md) — shared types and sync engine
