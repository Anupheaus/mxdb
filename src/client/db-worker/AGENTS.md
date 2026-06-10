# SQLite DB worker (`src/client/db-worker/`)

Browser-side SQLite via OPFS shared worker; inline in-memory runner for Node/test environments.

## Overview

Wraps `@sqlite.org/sqlite-wasm` in two modes: a `SharedWorker` (browser, OPFS persistence, multi-tab sharing) and an inline in-memory runner (Node.js, tests). `SqliteWorkerClient` selects the mode at runtime and exposes a uniform message-passing API to the rest of the client.

The `dbs` provider (`src/client/providers/dbs/`) builds `Db` and `DbCollection` on top of this module.

## Contents

### Entry point (`index.ts`)
Re-exports `SqliteWorkerClient`, `buildTableDDL`, `filtersToSql`, `sortsToSql`, and table-suffix constants.

### Worker client (`SqliteWorkerClient.ts`)
- `SqliteWorkerClient` — facade picking between `SharedWorker` and `InlineRunner`. Sends typed `WorkerRequest` messages and resolves `WorkerResponse` promises via ULID correlation ids.
- `InlineRunner` — co-located class; in-memory SQLite backed by `@sqlite.org/sqlite-wasm`. No OPFS, no cross-tab sharing. Used in tests and SSR.
- `setOnExternalChange(cb)` — fires when another browser tab writes to the shared SQLite; used by `Db` to reload the affected collection.

### Worker entry points
- `sqlite-worker.ts` — `Worker` (single-tab) entry
- `sqlite-shared-worker.ts` — `SharedWorker` (multi-tab) entry
- `sqlite-worker-shared.ts` — logic shared between both worker types

### DDL builder (`buildTableDDL.ts`)
- `buildTableDDL(config)` — generates `CREATE TABLE` statements for the three tables every collection gets:
  - `<name>` (live table) — current materialised record state
  - `<name>__audit` — audit trail entries
  - `<name>__sync` — sync metadata (branch anchor ULID, record hash)
- Constants: `LIVE_TABLE_SUFFIX`, `AUDIT_TABLE_SUFFIX`, `SYNC_TABLE_SUFFIX`

### SQL helpers
- `filtersToSql.ts` — translates `DataFilters` into parameterised SQL `WHERE` clauses
- `sortsToSql.ts` — translates `DataSorts` into SQL `ORDER BY` clauses

### Messages (`worker-messages.ts`)
`WorkerRequest` / `WorkerResponse` / `WorkerRequestWithCorrelationId` types for the postMessage protocol.

## Architecture

Every `SqliteWorkerClient` call assigns a ULID correlation id to the request and awaits the matching response `message` event. The inline runner resolves synchronously (wrapped in `Promise.resolve`).

All three tables for a collection are created in a single DDL transaction on `open()` — if any table fails, the whole open fails.

## Ambiguities and gotchas

- **`InlineRunner` is in-memory** — data does not persist across process restarts in tests. Reset state by creating a new `SqliteWorkerClient`.
- **SharedWorker URL resolution** — in browser builds the worker is loaded via `new SharedWorker(new URL('./sqlite-shared-worker.ts', import.meta.url))`. Build tooling must handle this URL transform; it is not a normal import.
- **`setOnExternalChange`** — only fires in browser environments with a real `SharedWorker`. In Node/InlineRunner mode the callback is never called.
- **REGEXP support** — both the inline runner and the SharedWorker register a custom SQLite `regexp(pattern, value)` function at open time. Without it, `$regex` filters would throw at runtime.
- **`#send` self-heals the shared port** — in `shared` mode `#send` awaits `#ensureSharedPort()` before posting, so a call that races ahead of `open()` can't dereference a null `#port` (mirrors the `dedicated` branch's lazy `#ensureWorker()`). Callers should still gate real writes on DB readiness (see `DbCollection.#runAfterReady`); this is the last-line guard, not the primary one.

## Related

- [../providers/dbs/AGENTS.md](../providers/dbs/AGENTS.md) — `Db` and `DbCollection` build on this
- [../../common/auditor/AGENTS.md](../../common/auditor/AGENTS.md) — auditor produces the entries stored here
