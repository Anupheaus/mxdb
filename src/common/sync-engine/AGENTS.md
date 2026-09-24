# Sync engine (`src/common/sync-engine/`)

Four-component protocol that moves data between clients and server. Framework-agnostic: it owns state and transitions; the layers above it own transport.

## Overview

| Component | Direction | Lives on | Responsibility |
|-----------|-----------|----------|----------------|
| `ClientDispatcher` (CD) | Client → Server | Client | Builds and dispatches C2S sync batches |
| `ServerReceiver` (SR) | Client → Server | Server | Receives batches, merges audits, replays, persists |
| `ServerDispatcher` (SD) | Server → Client | Server | Filters and dispatches S2C push payloads per client |
| `ClientReceiver` (CR) | Server → Client | Client | Applies S2C pushes to the local store |

One SR + SD pair per connected client on the server. One CD + CR pair per client.

## Full reference

**[sync-engine-reference.md](sync-engine-reference.md)** — living reference document covering every component's lifecycle, invariants, flow diagrams, race conditions, and regression test index. Read this before editing any file in this directory.

## Contents

- `ClientDispatcher.ts` / `.tests.ts`
- `ServerReceiver.ts` / `.tests.ts`
- `ServerDispatcher.ts` / `.tests.ts`
- `ClientReceiver.ts` / `.tests.ts` (delete-is-final; diagnostic logging only in hot path)
- `syncEngine.stress.tests.ts` — 12-client convergence stress test (run 5+ times when touching race-sensitive code)
- `models.ts` — shared request/response types (`MXDBRecordStates`, `MXDBRecordCursors`, `MXDBUpdateRequest`, `ServerDispatcherFilter`, `SyncPausedError`)
- `utils.ts` — helpers shared across components

## Rejected records (C2S)

A C2S response item may carry `rejectedRecords: { id, reason }[]` — records a server collection before-write hook refused. They are ALSO in `successfulRecordIds`: the `ClientDispatcher` settles them like any acknowledged record (so they are never resent) and reports them through its `onRejected` prop. The server reverts them (the `ServerReceiver` reads the states `onUpdate` persisted back — `onUpdate` may amend a state in place or replace it with a state for the same record — and pushes the reverted record, or a delete for a rejected create, to the client). Older clients ignore the field and still settle the records.

## Critical design rules

1. Audit entries are only ever **merged on the server** (`ServerReceiver`).
2. **No audit entries may ever be lost** — collapse/push/apply must preserve pending entries.
3. **Delete is final** — enforced at every boundary (CR, SD, SR, client store).
4. **In-memory read layer** — sync callbacks are synchronous because they hit an in-memory copy, not SQLite.
5. **Dispatchers never reject into fire-and-forget calls** — `ServerDispatcher.#dispatch` runs from `void` call sites (`push`, `resume`, retry timer). A failed `onDispatch` (e.g. the socket dropped mid-emit) is logged and retried with exponential backoff (`retryInterval` × 2ⁿ, capped at 30 s; reset on success). The queue is kept, so nothing is marked acknowledged. `close()`/`pause()` stops the retries. A rethrow here used to be an unhandled rejection that could terminate the server.

## Related

- [../auditor/AGENTS.md](../auditor/AGENTS.md) — auditor used for merge and replay
- [../../client/providers/AGENTS.md](../../client/providers/AGENTS.md) — C2S/S2C providers wire CD/CR
- [../../server/AGENTS.md](../../server/AGENTS.md) — server wires SR/SD per socket connection
