# Server database (`src/server/providers/db/`)

MongoDB persistence layer: connection, collection CRUD with audit, change stream fan-out, and async context.

## Overview

`ServerDb` owns the MongoDB connection and all `ServerDbCollection` instances. `ServerDbCollection` is the CRUD+audit layer for one MongoDB collection. `ServerDbCollectionEvents` batches change-stream events and fires `onAfter*` lifecycle hooks before notifying the socket layer. `DbContext` is the `AsyncLocalStorage` context that makes `useDb()` work inside socket request handlers without prop-drilling.

## Contents

### Database
- `ServerDb.ts` — `ServerDb` — `MongoClient` wrapper; creates `ServerDbCollection` per config, opens change stream, fans out change events per collection. Constructor takes a `watch?: boolean` prop (default **true**); when `false`, the change-stream watcher is never started (`#startWatching` is skipped after connect) — for write-only callers such as a controller writing into a tenant DB whose owning server already watches it
- `ServerDbCollection.ts` — per-collection CRUD with audit: `get`, `getAll`, `find`, `query`, `upsert`, `remove`, `sync` (sync-engine write path), `distinct`, `clear`
- `ServerDbCollectionEvents.ts` — debounced change-stream fan-out; accumulates events within `changeStreamDebounceMs`, runs `onAfter*` hooks, then notifies the socket layer via registered callbacks

### Context
- `DbContext.ts` — `AsyncLocalStorage`-based context
- `provideDb.ts` — `provideDb(mongoDbName, url, collections, cb, options?)` — creates a `ServerDb`, runs `cb` inside the storage context. `options` is `{ changeStreamDebounceMs?, watch? }` (5th positional arg, both optional)
- `withDb.ts` — `withDb(db, delegate)` — scopes the ambient context to an **existing** `ServerDb` and runs `delegate`, without constructing a new connection. For reusing a cached `ServerDb` (e.g. one built earlier via `provideDb(..., { watch: false })`) across multiple calls instead of reconnecting each time. Establishes a no-op server→client sync, since the owning server's own change stream (if any) already propagates the write
- `useDb.ts` — `useDb()` — retrieves `ServerDb` from async context
- `connectionDbRouter.ts` — generic per-connection DB routing, wired to nexus's `onResolveConnection` auth hook by `startAuthenticatedServer`. `createConnectionDbPool(makeServerDb)` — a get-or-create pool of `ServerDb` keyed by `` `${mongoDbUrl}::${dbName}` ``, plus `closeAll()`. `resolveAndScopeConnection(handshake, deps)` — calls `deps.resolveConnectionDb(handshake)`; if it returns a target, calls `deps.setDb(deps.getOrCreateServerDb(target))`, else no-op. Injected deps make it unit-testable without a real Mongo/socket. Consumer-supplied and optional — absent `resolveConnectionDb` on `ServerConfig` means the pool is never populated and no per-connection `setDb` happens (single-DB behaviour unchanged)

### Models and utilities
- `server-db-models.ts` — `ServerDbChangeEvent` and related shapes
- `db-transforms.ts` — MongoDB serialization/deserialization (`serialize`/`deserialize`): maps `id` ↔ `_id` and converts Luxon `DateTime` ↔ native BSON `Date` (via `Object.clone` with a value transformer). Dates are stored as BSON `Date`s — **not** ISO strings — so `$lt`/`$gt` range queries match (the query path converts `DateTime` filter bounds to `Date`). On read, stored `Date`s (and any legacy ISO-string dates) are revived into `DateTime`s
- `clientS2CStore.ts` — per-client store used by the S2C dispatch path

## Architecture

Change stream lifecycle:
1. `ServerDb` opens a MongoDB change stream on startup.
2. Each insert/update/delete event routes to the matching `ServerDbCollectionEvents` instance.
3. `ServerDbCollectionEvents` accumulates events within `changeStreamDebounceMs` (default 20ms), then:
   a. Runs `onAfterUpsert` / `onAfterDelete` hooks for all batched records.
   b. Notifies registered callbacks (which trigger `ServerDispatcher.push` for each connected client).
4. This two-step ensures clients are notified only after cascade effects have been applied.

`ServerDbCollection.sync()` is the write path for `clientToServerSyncAction`. It performs a per-record exponential-backoff retry loop (base 100ms, max 2s, up to 20 retries) for transient MongoDB errors.

## Ambiguities and gotchas

- **`MongoDocOf<T>`** maps `id` → `_id` and Luxon `DateTime` → native BSON `Date`. All documents stored in MongoDB use this shape. `db-transforms.ts` handles the conversion — never write raw records directly to the MongoDB driver. **Dates must be stored as BSON `Date`s, not ISO strings**, otherwise `$lt`/`$gt` range queries silently match nothing (the query path compares against `Date` bounds).
- **Filter translation (`find` / `query` / `distinct`)** — `id` keys become `_id` and Luxon `DateTime`s become `Date`s **recursively, including inside arrays**, so `$or`/`$and`/`$nor` clauses and `$in`/`$nin` values are translated too. The caller's filter object is never mutated. (`id` is renamed at *any* depth, including inside embedded-document filters such as `$elemMatch: { id }`; be aware of this if a sub-document genuinely has an `id` field.)
- **Sort translation** — `DataSorts` become a Mongo sort *document* `{ field: 1 | -1 }` (`id` → `_id`), which works for both `find()` and the aggregation `$sort` in `distinct()`. `query()` always has a stable order so offset/limit pages never overlap: with no sort it uses natural (insertion) order, and with a sort it appends `_id` ascending as a final tie-breaker (unless `_id` is already sorted on).
- **Retry backoff in `sync()`** handles transient close errors (`isTransientMongoCloseError`); all other errors are returned as `SyncWriteResult.error` and reported back to the client without retrying.
- **`changeStreamDebounceMs` trades latency for throughput** — lower values dispatch faster but increase per-event load. Default 20ms.
- **`AsyncLocalStorage` context must be active** for `useDb()` to work. If you see "no ServerDb in context" in tests, ensure the call is wrapped in `provideDb`.
- **`watch: false` means no change stream at all** — inserts/updates/deletes on that `ServerDb` never fire `onAfter*` extension hooks and never notify connected clients. Only use it for a `ServerDb` whose collection(s) are already watched elsewhere (e.g. the owning server's own default `ServerDb`), and reuse that one `ServerDb` instance via `withDb()` rather than constructing a fresh watch-free connection per call.

## Related

- [../../common/auditor/AGENTS.md](../../common/auditor/AGENTS.md) — auditor used for merge/replay in `sync()`
- [../../collections/AGENTS.md](../../collections/AGENTS.md) — `onAfter*` hooks invoked by `ServerDbCollectionEvents`
- [../../AGENTS.md](../../AGENTS.md) — parent server directory
