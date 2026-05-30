# SQLite dbs provider (`src/client/providers/dbs/`)

Manages per-device SQLite databases — one `Db` per `MXDBSync` instance, one `DbCollection` per registered collection.

## Overview

The `dbs` provider creates and holds the `Db` instance which in turn owns a `SqliteWorkerClient`. Every collection operation performed via `useCollection` ultimately calls a `DbCollection` method here. The provider also maintains an in-memory copy of each collection's current records so that reactive hooks can read synchronously without hitting SQLite.

## Contents

### Provider / context
- `Dbs.ts` / `DbsProvider` — React provider; creates `Db` on mount, tears it down on unmount
- `DbContext.ts` / `useDb()` — context hook returning the `Db` instance

### Database classes
- `Db.ts` — per-device database; wraps `SqliteWorkerClient`, creates `DbCollection` per config, wires `setOnExternalChange` for cross-tab reload
- `DbCollection.ts` — per-collection API: `get`, `getAll`, `find`, `query`, `upsert`, `remove`, `onChange`, `reloadFromWorker`; sync-engine write methods: `applyServerWriteSync` (one record), `batchApplyServerWriteSync` (many records — preferred during reconciliation), `applyServerDeleteSync`, `collapseAuditSync`

### Models and utilities
- `models.ts` — `MXDBCollectionEvent` (change notification shape)
- `utils.ts` — internal helpers (e.g. audit entry encoding for SQLite)
- `dbs-consts.ts` — shared constants (column names, table suffixes)

### Tests
- `DbCollection.batchApply.tests.ts` — `batchApplyServerWriteSync` batching, single `onChange`, SQLite persistence

## Architecture

`Db` is created once at mount. It calls `SqliteWorkerClient.open()` with the DDL for all configured collections. Once open, each `DbCollection` exposes both a synchronous in-memory read layer (for reactive hooks) and async SQLite-backed write/read methods.

The in-memory layer is refreshed on every write (local or incoming S2C). `reloadFromWorker()` re-reads from SQLite when a `SharedWorker` signals that another browser tab has written to the database.

## Ambiguities and gotchas

- **`DbCollection.applyServerWriteSync` / `batchApplyServerWriteSync`** are called by the C2S/S2C providers to apply server-driven record updates. They are not part of the public `useCollection` API. **Always prefer `batchApplyServerWriteSync`** when applying multiple records at once (e.g. during reconnect reconciliation) — it posts one SQLite exec-batch and fires one onChange instead of N each, avoiding worker queue pile-up and repeated OPFS flushes that cause multi-second query delays on large databases.
- **Luxon `DateTime` is stored as ISO strings** in SQLite. `DbCollection` uses `to.serialise`/`to.deserialise` from `@anupheaus/common` for all row reads and writes — do not write raw values to the SQLite layer.
- **Auth table** — `Db` creates an internal `mxdb_authentication` table on open alongside the user-defined collection tables. It stores the encrypted auth token and is never exposed through `DbCollection`.

## Related

- [../../db-worker/AGENTS.md](../../db-worker/AGENTS.md) — `SqliteWorkerClient` used by `Db`
- [../../hooks/useCollection/AGENTS.md](../../hooks/useCollection/AGENTS.md) — all collection ops call into `DbCollection`
- [../AGENTS.md](../AGENTS.md) — parent providers directory
