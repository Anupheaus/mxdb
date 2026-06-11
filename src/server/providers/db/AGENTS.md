# Server database (`src/server/providers/db/`)

MongoDB persistence layer: connection, collection CRUD with audit, change stream fan-out, and async context.

## Overview

`ServerDb` owns the MongoDB connection and all `ServerDbCollection` instances. `ServerDbCollection` is the CRUD+audit layer for one MongoDB collection. `ServerDbCollectionEvents` batches change-stream events and fires `onAfter*` lifecycle hooks before notifying the socket layer. `DbContext` is the `AsyncLocalStorage` context that makes `useDb()` work inside socket request handlers without prop-drilling.

## Contents

### Database
- `ServerDb.ts` — `ServerDb` — `MongoClient` wrapper; creates `ServerDbCollection` per config, opens change stream, fans out change events per collection
- `ServerDbCollection.ts` — per-collection CRUD with audit: `get`, `getAll`, `find`, `query`, `upsert`, `remove`, `sync` (sync-engine write path), `distinct`, `clear`
- `ServerDbCollectionEvents.ts` — debounced change-stream fan-out; accumulates events within `changeStreamDebounceMs`, runs `onAfter*` hooks, then notifies the socket layer via registered callbacks

### Context
- `DbContext.ts` — `AsyncLocalStorage`-based context
- `provideDb.ts` — `provideDb(mongoDbName, url, collections, cb)` — creates `ServerDb`, runs `cb` inside the storage context
- `useDb.ts` — `useDb()` — retrieves `ServerDb` from async context

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
- **Retry backoff in `sync()`** handles transient close errors (`isTransientMongoCloseError`); all other errors are returned as `SyncWriteResult.error` and reported back to the client without retrying.
- **`changeStreamDebounceMs` trades latency for throughput** — lower values dispatch faster but increase per-event load. Default 20ms.
- **`AsyncLocalStorage` context must be active** for `useDb()` to work. If you see "no ServerDb in context" in tests, ensure the call is wrapped in `provideDb`.

## Related

- [../../common/auditor/AGENTS.md](../../common/auditor/AGENTS.md) — auditor used for merge/replay in `sync()`
- [../../collections/AGENTS.md](../../collections/AGENTS.md) — `onAfter*` hooks invoked by `ServerDbCollectionEvents`
- [../../AGENTS.md](../../AGENTS.md) — parent server directory
