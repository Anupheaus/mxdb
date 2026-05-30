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

## Critical design rules

1. Audit entries are only ever **merged on the server** (`ServerReceiver`).
2. **No audit entries may ever be lost** — collapse/push/apply must preserve pending entries.
3. **Delete is final** — enforced at every boundary (CR, SD, SR, client store).
4. **In-memory read layer** — sync callbacks are synchronous because they hit an in-memory copy, not SQLite.

## Related

- [../auditor/AGENTS.md](../auditor/AGENTS.md) — auditor used for merge and replay
- [../../client/providers/AGENTS.md](../../client/providers/AGENTS.md) — C2S/S2C providers wire CD/CR
- [../../server/AGENTS.md](../../server/AGENTS.md) — server wires SR/SD per socket connection
