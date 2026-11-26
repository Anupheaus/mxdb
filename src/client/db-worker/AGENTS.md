# SQLite DB worker (`src/client/db-worker/`)

Browser-side SQLite via OPFS shared worker; inline in-memory runner for Node/test environments.

## Overview

Wraps `@sqlite.org/sqlite-wasm` in two modes: a `SharedWorker` (browser, OPFS persistence, multi-tab sharing) and an inline in-memory runner (Node.js, tests). `SqliteWorkerClient` selects the mode at runtime and exposes a uniform message-passing API to the rest of the client.

The `dbs` provider (`src/client/providers/dbs/`) builds `Db` and `DbCollection` on top of this module.

## Contents

### Entry point (`index.ts`)
Re-exports `SqliteWorkerClient`, `buildTableDDL`, `sortsToSql`, and table-suffix constants.

### Worker client (`SqliteWorkerClient.ts`)
- `SqliteWorkerClient` — facade picking between `SharedWorker` and `InlineRunner`. Sends typed `WorkerRequest` messages and resolves `WorkerResponse` promises via ULID correlation ids.
- `InlineRunner` — co-located class; in-memory SQLite backed by `@sqlite.org/sqlite-wasm`. No OPFS, no cross-tab sharing. Used in tests and SSR.
- `setOnExternalChange(cb)` — fires when another browser tab writes to the shared SQLite; used by `Db` to reload the affected collection.

### Worker entry points
- `sqlite-worker.ts` — `Worker` (single-tab) entry
- `sqlite-shared-worker.ts` — `SharedWorker` (multi-tab) entry
- `sqlite-worker-shared.ts` — logic shared between both worker types
- `encryptedFlushScheduler.ts` — coalesces persisting the encrypted database's snapshot: a write only marks it dirty; ONE flush runs at a time, about 1 s after the last write and at most every 5 s under constant writes, plus on close, a database switch and a `flush` request (sent by `SqliteWorkerClient` when a tab is hidden or unloads). A failed flush is logged and retried, never thrown (sc-680)
- `encryptedWriteAheadLog.ts` — makes each write of the encrypted database durable before it is answered. The workers apply the write, then `append` its statements in the same synchronous step (which numbers it), and reply only once the log file is in OPFS: `<db>.wal/<16-digit last seq>.wal`, `[12-byte IV][AES-GCM(JSON entries)]`. Writes that arrive while a file is being written share the next file (group commit), so files complete in order. A snapshot first records the last sequence number in the database (`mxdb_wal_state`, one row) and then exports it (`flushEncrypted` exports before its first `await`); once `flushEncrypted` reports the snapshot written (it now resolves `true`/`false`), the files it covers are removed. On open, after the snapshot is loaded and the open's DDL has run, the entries numbered after the snapshot are replayed in order, each in its own transaction, exactly once. A log file that cannot be written still lets the write be answered (logged; the next snapshot holds it); an entry that cannot be replayed is skipped and logged

### DDL builder (`buildTableDDL.ts`)
- `buildTableDDL(config)` — generates `CREATE TABLE` statements for the three tables every collection gets:
  - `<name>` (live table) — current materialised record state
  - `<name>__audit` — audit trail entries
  - `<name>__sync` — sync metadata (branch anchor ULID, record hash)
- Constants: `LIVE_TABLE_SUFFIX`, `AUDIT_TABLE_SUFFIX`, `SYNC_TABLE_SUFFIX`

### SQL helpers
- **No SQL filter translation** (sc-2518 QA round 5). SQLite never evaluates a filter: `DbCollection` chooses records in memory with `queryRecordsInMemory.ts` → `createFilterMatcher` (`src/common/filters`), which reads the canonical filter exactly as MongoDB does, so the device and the server cannot disagree. `queryRecordsInMemory.performance.tests.ts` keeps it within 1.5x of master's old sift fast path. The former `filtersToSql.ts` / `dataFiltersToSift.ts` read some whitelisted shapes differently from MongoDB (the bare-list shorthand, JavaScript-vs-PCRE regex) and were removed.
- `queryRecordsInMemory.ts` — filter (via `createFilterMatcher`, compiled once per query), sort and paginate the live-record cache; `distinctRecordsInMemory` collects scalar distinct values from already-matched records (non-scalar values are read by SQL, but only for the matched ids).
- `sortsToSql.ts` — translates `DataSorts` into SQL `ORDER BY` clauses

### Messages (`worker-messages.ts`)
`WorkerRequest` / `WorkerResponse` / `WorkerRequestWithCorrelationId` types for the postMessage protocol.

## Architecture

Every `SqliteWorkerClient` call assigns a ULID correlation id to the request and awaits the matching response `message` event. The inline runner resolves synchronously (wrapped in `Promise.resolve`).

All three tables for a collection are created in a single DDL transaction on `open()` — if any table fails, the whole open fails.

## Ambiguities and gotchas

- **The encrypted database's snapshot is not written per write** (sc-680). `flushEncrypted` exports and encrypts the WHOLE database — about twice its size in memory — so running it per write, several at once, exhausted the worker ("Array buffer allocation failed"). Snapshots go through `encryptedFlushScheduler`; never call `flushEncrypted` directly from a write path. Durability comes from the write-ahead log instead: each write costs one small encrypted file (about the size of the change; 1-3 ms in Chromium, measured in a SharedWorker for 0.5-500 KB), so a write answered is a write kept.
- **Why a write-ahead log, not a flush on `pagehide`.** Before it, a page reloaded or closed within about a second of a change lost it entirely: the worker is stopped with its last page, and the `flush` asked for on `pagehide` is an async export + encrypt + OPFS write that does not finish in time (Vision's `device-dashboard.spec.ts` hit it). Nothing synchronous can help: the page cannot wait for a worker, OPFS sync access handles exist only in dedicated workers (not the SharedWorker), and localStorage would hold the change unencrypted. The log uses only what the snapshot already uses (`createWritable` on OPFS, WebCrypto), so it works wherever the snapshot does: Chromium, and Android WebView (Capacitor), where the dedicated worker runs. OPFS commits a writable only on `close()`, so a worker stopped mid-write leaves the previous file, never a partial one. The `pagehide` flush stays: it only saves replaying the log on the next open.
- **Opens are serialised in each worker** (`openQueue`). An open awaits OPFS and the log replay before it installs the database (built on locals, so no request sees a half-opened one); two interleaved opens would install two copies with colliding sequence numbers.
- **What is still not covered.** A write still on its way to the worker when the page goes (posted but not yet answered) can be lost; `DbCollection.upsert`/`delete` resolve only once the worker has answered, so a caller that awaits them knows the change is kept. Encryption at rest is unchanged: nothing plaintext reaches OPFS (log files included) and the key is never persisted.
- **`InlineRunner` is in-memory** — data does not persist across process restarts in tests. Reset state by creating a new `SqliteWorkerClient`.
- **SharedWorker URL resolution** — in browser builds the worker is loaded via `new SharedWorker(new URL('./sqlite-shared-worker.ts', import.meta.url))`. Build tooling must handle this URL transform; it is not a normal import.
- **`setOnExternalChange`** — only fires in browser environments with a real `SharedWorker`. In Node/InlineRunner mode the callback is never called.
- **REGEXP support** — both the inline runner and the SharedWorker register a custom SQLite `regexp(pattern, value)` function at open time. Filters no longer reach SQL (sc-2518), so `$regex` is matched by `createFilterMatcher`, not by this function; it stays registered for any raw SQL that uses `REGEXP`.
- **`#send` self-heals the shared port** — in `shared` mode `#send` awaits `#ensureSharedPort()` before posting, so a call that races ahead of `open()` can't dereference a null `#port` (mirrors the `dedicated` branch's lazy `#ensureWorker()`). Callers should still gate real writes on DB readiness (see `DbCollection.#runAfterReady`); this is the last-line guard, not the primary one.
- **`open()` is idempotent per database name** — both workers track `openDbName`. A repeat `open` of the **same** database (another tab through the SharedWorker, or the same tab re-opening) does **not** close+reopen the instance; it just re-runs the (idempotent) DDL and replies. This is critical: closing+reopening briefly sets `db` to `null`, so any query in flight from another tab would throw `Database not open`. A genuine switch to a **different** database name still closes the old instance first. The name is account/user-scoped (`accountId ?? userId`), so same-name ⇒ same encryption key.

## Related

- [../providers/dbs/AGENTS.md](../providers/dbs/AGENTS.md) — `Db` and `DbCollection` build on this
- [../../common/auditor/AGENTS.md](../../common/auditor/AGENTS.md) — auditor produces the entries stored here
