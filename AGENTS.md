# MXDB Library Overview

## Before making changes

<EXTREMELY_IMPORTANT>
You MUST read `C:\code\personal\agents\agents.md` before doing anything else in this repo. This is non-negotiable and cannot be skipped under any circumstances.
</EXTREMELY_IMPORTANT>
- **Search `@anupheaus/common` before writing utility functions**: The common library (`c:/code/personal/common/src/`) provides many utilities — serialisation (`to.serialise`, `to.deserialise`), deep equality (`is.deepEqual`, handles Luxon DateTime, Date, functions), object cloning (`Object.clone`), type guards, and more. Before implementing anything locally, search the common library first. Using existing common utilities avoids duplicated logic and benefits from already-correct edge-case handling (e.g. `is.deepEqual` uses `DateTime.equals()` for Luxon, not naive JSON comparison).

## Documentation

All of this ships in the published package under **`docs/`** (see **`package.json` → `files`**). Start from the index, then drill into guides vs reference vs plans.

- **Index (table of contents):** [docs/README.md](docs/README.md)
- **Guides**
  - [docs/guides/client-guide.md](docs/guides/client-guide.md) — React app: `MXDBSync`, `useCollection`, auth, sync UX
  - [docs/guides/server-guide.md](docs/guides/server-guide.md) — `startServer`, MongoDB, extensions, auth
- **Reference**
  - [docs/reference/tech-overview.md](docs/reference/tech-overview.md) — architecture and sync flows (Mermaid)
  - [docs/reference/features.md](docs/reference/features.md) — exports, socket actions / events / subscriptions
- **Plans / target specs:** [docs/plans/](docs/plans/) — C2S/S2C specs, client record creation, [docs/plans/design.md](docs/plans/design.md) (master design)
- **Archive:** [docs/archive/](docs/archive/) — older trackers (see [docs/archive/README.md](docs/archive/README.md))

**Root [README.md](README.md)** — quick start, exports, and links back to **`docs/README.md`**.

## Architecture Summary

MXDB is a real-time synchronization library for MongoDB-backed collections between clients and servers. It provides a three-layer architecture:

### Core Components

**Common Layer** (`src/common/`)
- Collection definitions via `defineCollection()`
- Shared types and models
- Internal actions, events, and subscriptions
- Seeding utilities

**Server Layer** (`src/server/`)
- `startServer()` - Main server initialization
- Collection API and extension hooks
- MongoDB change stream integration
- Real-time notifications via Socket.IO

**Client Layer** (`src/client/`)
- React provider (`MXDBSync`) 
- Hooks (`useCollection`, `useMXDB`, `useRecord`)
- Local IndexedDB storage with sync capabilities
- Real-time updates and offline support

## Key Features

1. **Real-time Sync**: Uses MongoDB change streams to notify clients of changes
2. **Offline Support**: Clients store data locally in IndexedDB and sync when reconnected
3. **Audit Trail**: Maintains change history for conflict resolution
4. **React Integration**: Native React hooks and components
5. **Extensible**: Server-side hooks for validation and cascading updates

## Data Flow

### Server Operations
1. Client actions (upsert/remove) received via Socket.IO
2. Server validates and writes to MongoDB
3. MongoDB change stream detects changes
4. Server runs `onAfter` hooks then notifies clients
5. Clients receive updates and apply to local IndexedDB

### Client Operations
1. Local changes stored immediately in IndexedDB
2. If connected, changes sent to server
3. If disconnected, changes queued for sync
4. On reconnect, synchronization process runs
5. Conflict resolution using ULID-based last-write-wins (audit entry ULID, NOT any record field)

## Conflict Resolution: ULID-Based Last-Write-Wins

**The ONLY mechanism for conflict resolution is the ULID of the audit entry.** The entry with the highest ULID (latest real-world write time) wins when two writes conflict.

- `replayHistoryEndState` in `src/common/auditor/replay.ts` sorts all audit entries by ULID and applies them in order. The last applied state is the record's final value.
- `audit.merge` in `src/common/auditor/api.ts` merges server + client audits by deduplicating and sorting all entries by ULID.
- **Record fields like `testDate` (or any other application-level field) have NO effect on conflict resolution.** They are arbitrary data stored on the record. Only the ULID of the audit entry matters.
- `testDate` on `E2eTestRecord` is an optional test-only field — it is explicitly NOT used by the sync system for ordering or conflict resolution.

## Deletion and Restoration Behaviour

**Updates after a deletion do NOT restore a record.** When an `Updated` entry has a higher ULID than a `Deleted` entry, the record remains deleted. The `Updated` entry is still applied to the `shadow` state (preserving the changes), but `live` stays `undefined` until an explicit `Restored(3)` entry is present.

**Restoration is a separate, manual process that has not been implemented yet.** A user who wants to un-delete a record must explicitly apply a `Restored` audit entry. There is currently no automatic restoration pathway — not from concurrent updates, not from conflict resolution. Only `AuditEntryType.Restored` (3) can bring a record back from `live=undefined` to a live state.

**Clients may still send C2S updates for a record after receiving it in `removedIds`.** If the local audit has pending changes (entries after the last Branched anchor) at the time the S2C deletion arrives, the S2C handler skips the deletion and keeps the local record. This is expected and intentional — the pending changes cannot be discarded until they have been pushed to the server and acknowledged. The flow is:
1. S2C deletion arrives → client has `hasPendingChanges=true` → deletion skipped, record retained locally
2. Client sends pending changes via C2S sync
3. Server ACKs the update (the record appears in `successfulRecordIds` even though the server sees it as deleted — no error is set for a deleted record result)
4. Client collapses audit to a `Branched(4)` anchor → `hasPendingChanges=false`
5. Server fires a follow-up S2C deletion (fire-and-forget from the C2S handler) to this specific client
6. S2C deletion re-arrives after the C2S gate opens → `hasPendingChanges=false` → deletion proceeds

## Sync Test Infrastructure

Located in `tests/sync-test/`, this is a comprehensive data integrity test suite:

### Test Components
- **20 simulated clients** using real React components and fake-indexeddb
- **MongoDB Memory Server** for isolated testing
- **Records of Truth** tracking expected final state
- **Integrity assertions** comparing server vs expected state

### Test Scenarios
- Random client updates while connected/disconnected
- Network delays and disconnections
- Server restart mid-session
- Concurrent operations from multiple clients

## Critical Design Principles

**Data Integrity is Paramount**: This library's primary purpose is maintaining data consistency across distributed clients. Any changes must prioritize:
- **Preserving audit records** - Never truncate or lose audit trail data
- **Maintaining referential integrity** - Ensure cascading updates don't orphan data
- **Atomic operations** - Changes should be all-or-nothing to prevent partial states
- **Conflict resolution** - ULID-based last-write-wins: the audit entry with the highest ULID wins; record fields like `testDate` have no effect on conflict resolution

**Audit Record Preservation**: When making any changes to this library:
- Never remove or modify existing audit trail entries
- Ensure all write operations append to audit trails rather than replacing them
- Test thoroughly with the sync test suite to verify audit integrity
- Consider backward compatibility for existing audit data

## Running "All" Tests

When the user asks to run "all" tests, **do NOT invoke the suites individually**. Run the single orchestrator script:

```
pnpm test:all
```

(equivalent: `node scripts/run-all-tests.mjs`)

The script runs Unit, CRUD, Performance, and Stress sequentially, records the wall-clock duration and pass/fail counts of each, and prints a machine-readable JSON block to stdout between `=== RESULTS_JSON_BEGIN ===` and `=== RESULTS_JSON_END ===` markers.

## Related

- [src/AGENTS.md](src/AGENTS.md) — source code navigation (common / client / server)
- [docs/README.md](docs/README.md) — documentation index
- [tests/AGENTS.md](tests/AGENTS.md) — e2e test infrastructure
- [test/AGENTS.md](test/AGENTS.md) — manual test app

**How to report the results back to the user:**

1. Run `pnpm test:all` via the Bash tool. The suites are long-running (especially Stress) — use a generous timeout.
2. Locate the `=== RESULTS_JSON_BEGIN ===` / `=== RESULTS_JSON_END ===` block in the output.
3. Parse the JSON. The shape is:
   ```json
   {
     "schema": "mxdb.test-run.v1",
     "totalWallMs": 123456,
     "suites": [
       { "key": "unit", "label": "...", "exitCode": 0, "durationMs": 1234,
         "tests": { "passed": 42, "failed": 0, "skipped": 0, "total": 42 } }
     ]
   }
   ```
4. Render a table like:

   | Suite       | Status | Tests          | Duration |
   |-------------|--------|----------------|----------|
   | Unit        | ✅      | 42/42 passed   | 1.2s     |
   | CRUD        | ✅      | 18/18 passed   | 14.3s    |
   | Performance | ❌      | 5/6 passed (1 failed) | 32.7s |
   | Stress      | ✅      | 3/3 passed     | 4m 12.1s |

   - **Status**: ✅ if `exitCode === 0`, ❌ otherwise.
   - **Tests**: `passed/total passed`, append `(N failed)` / `(N skipped)` if non-zero. If a suite's summary could not be parsed (`parsed: false`), show `(summary unavailable)`.
   - **Duration**: format `durationMs` as `Xms`, `X.XXs`, or `Xm X.Xs` as appropriate.

5. Always report all four rows even if the script exited non-zero — the full picture is more useful than early termination.

**Do not run the individual `pnpm test`, `pnpm test:crud`, etc. commands for an "all tests" request** — the orchestrator is the single source of truth for this workflow.
