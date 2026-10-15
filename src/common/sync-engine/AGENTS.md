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
- `dispatchBatches.ts` — splits a C2S dispatch into socket-sized emits (sc-623, see below)
- `ServerReceiver.ts` / `.tests.ts`
- `ServerDispatcher.ts` / `.tests.ts`
- `ClientReceiver.ts` / `.tests.ts` (delete-is-final; diagnostic logging only in hot path)
- `syncEngine.stress.tests.ts` — 12-client convergence stress test (run 5+ times when touching race-sensitive code)
- `models.ts` — shared request/response types (`MXDBRecordStates`, `MXDBRecordCursors`, `MXDBUpdateRequest`, `ServerDispatcherFilter`, `SyncPausedError`)
- `utils.ts` — helpers shared across components

## Rejected records (C2S)

A C2S response item may carry `rejectedRecords: { id, reason, kind }[]` — records a server collection before-write hook (or the read gate) refused; `kind` (`validation` | `access` | `error`, see `MXDBSyncRejectionKind`) says whether `reason` is a message for the user, and is passed through to `onRejected` unchanged (absent from older servers). They are ALSO in `successfulRecordIds`: the `ClientDispatcher` settles them like any acknowledged record (so they are never resent) and reports them through its `onRejected` prop. The server reverts them (the `ServerReceiver` reads the states `onUpdate` persisted back — `onUpdate` may amend a state in place or replace it with a state for the same record — and pushes the reverted record, or a delete for a rejected create, to the client). Older clients ignore the field and still settle the records.

## Amended records (C2S)

A C2S response item may also carry `amendedRecords: { id, note }[]` — records whose change the server SAVED but partly amended, where the `onBeforeUpsert` hook returned a note saying what it put back and why (only for a record it really changed, and not one it then rejected). They are in `successfulRecordIds` and the amended record is pushed back as for any amendment; the `ServerReceiver` passes the field through and the `ClientDispatcher` hands the notes of one response, in one call, to its `onAmended` prop (as `MXDBSyncAmendment`: `{ collectionName, recordId, note }`). Absent from servers older than 0.2.8; older clients ignore it.

## The read gate (C2S)

A sync request can name any record id — a branch-only probe claiming a stale hash, or an update — and the `ServerReceiver` answers a disparity with the stored (or merged) record. So the server passes `onReadReadable`: of the request's ids, the live records this client may read, read through the collection's `onQuery` gate in ONE query (see `src/server/collections/AGENTS.md`). The receiver calls it **after** persisting (a record the client just created is judged as stored). For a record it returns, content is sent only when it is the version the gate passed (same hash): one that changed after the receiver read or merged it is left to the change stream, which reads it through the gate again — so a record is never judged on one version and sent as another (sc-682). For every id it does not return:

- answers it only with an **eviction** (a delete cursor with `isEviction: true`) when the client claimed it — never its content, and never a plain delete — whether it is live, deleted or was never stored, so the client cannot tell those apart (sc-608). A record the server holds as a tombstone is still tombstoned in the SD, so the delete stays final for the connection. A refused write to a live record outside the gate is evicted too, so the device drops its edit (sc-612).
- **removes it from the `ServerDispatcher` filter** (`removeFromFilter`) that the mirror seeded from the client's claim, so claiming an id does not subscribe the client to its change-stream updates. This is not a delete: no tombstone.

The record is still acknowledged in `successfulRecordIds`. (On the server, an update or delete to a record whose STORED version is outside the gate is refused before it is persisted — `server/actions/rejectWritesOutsideReadGate.ts`.) Without `onReadReadable` (unit tests, ungated servers) every record is readable.

**Fail closed.** The mirror subscribes the client to every id it claims before any await. If `process` throws before the gate has vetted those claims (a failed retrieve, a gate that throws), the `finally` removes every claimed id of the request from the filter before resuming; the client re-claims them on its retry. The pause and the mirror sit inside the `try`, so a request that cannot even be mirrored still reaches the `finally` and never leaves the SD paused.

**Pauses nest.** `ServerDispatcher.pause()` is re-entrant (a depth count): overlapping C2S syncs on one socket each pause it, and dispatch resumes only when the last one resumes — otherwise the first to finish would release a claim the other had mirrored but not yet vetted.

## Evictions (S2C)

An eviction (`MXDBDeletedRecordCursor.isEviction`) tells a client to drop a record it may no longer hold. It is NOT a delete:

- **ServerDispatcher.** A change-stream eviction is sent only to a client that holds the record (it is in the filter); an authoritative one always is, even for a tombstoned id — it carries nothing. On an answer (acknowledged or declined) the record is removed from the filter WITHOUT a tombstone, so an authoritative push under the new gate delivers it again. Squashed with other cursors for the same record, it never beats a real delete, and the later of an eviction and an active cursor wins.
- **ClientReceiver.** With nothing pending it is applied like a delete (the local copy goes, no tombstone is kept); with local changes still to sync it is declined — those changes reach the server first.

## Retry backoff (C2S)

A C2S dispatch goes in emits of at most `MAX_DISPATCH_BYTES` (4 MB) — nexus closes a socket whose message passes 10 MB, and an oversize payload would be retried forever, so a big offline backlog would stop the device syncing at all (sc-623). Sizes are what the wire carries (`estimateDispatchBytes`): the request's JSON (`to.serialise`) in UTF-8 — the request is an array, which nexus's socket parser encodes once. `dispatchBatches.ts` fills emits in order, each record whole (its audit entries never split, so its changes stay in order); a record bigger than an emit goes alone. A record bigger than `MAX_RECORD_DISPATCH_BYTES` (9 MB, leaving 1 MB of envelope) could never get through: it is taken off the queue, not sent and **not retried** — its pending audit carries the oversize entry, so a later, smaller edit does not help — and reported once per session through `onTooLarge` (the client surfaces it as an `onError` `SYNC_TOO_LARGE` error, severity `error`); it never blocks the others. The emits go one after another, each settled as its answer arrives; a failed emit the server answered backs off only its own records and never stops the ones after it; an authentication failure, a timeout or a lost connection stops the rest, which wait for the next tick. The start-up sweep is retried as a whole only when no emit got through. Nothing at all to send is still one empty dispatch (the start-up sweep's); when every change due was refused, nothing is sent. Both limits are props (`maxDispatchBytes`, `maxRecordDispatchBytes`). The C2S action is socket-only (REST's 512 KB body limit would refuse a 4 MB emit).

The `ClientDispatcher` tracks consecutive failures per queued record — a dispatch that throws, or a response that does not acknowledge the record. The first `SYNC_FAST_RETRY_ATTEMPTS` retries run at the normal timer interval (transient blips); after that the delay doubles from `SYNC_RETRY_BASE_DELAY_MS` up to `SYNC_RETRY_MAX_DELAY_MS` (`syncRetryPolicy.ts`). A backing-off record is left out of dispatches until its retry is due and never holds up other records (an enqueue of a due record brings a long wait forward). After `SYNC_ATTEMPTS_BEFORE_STALLED` attempts it is reported once through `onStalled` (the client surfaces it as an `onError` `SYNC_STALLED` error) — and keeps retrying; nothing is ever dropped. The start-up sweep backs off the same way and reports without a record id. `stop()` forgets all backoff state (a new session re-sweeps).

## Critical design rules

1. Audit entries are only ever **merged on the server** (`ServerReceiver`).
2. **No audit entries may ever be lost** — collapse/push/apply must preserve pending entries. The one exception is deliberate: a client entry older than the start of the server's history for the record (an audit reset with `resetAudit`, which clears old versions on purpose) is dropped by the `ServerReceiver`, since it could not change the record and would bring the cleared values back.
3. **Delete is final** — enforced at every boundary (CR, SD, SR, client store).
4. **In-memory read layer** — sync callbacks are synchronous because they hit an in-memory copy, not SQLite.
5. **Dispatchers never reject into fire-and-forget calls** — `ServerDispatcher.#dispatch` runs from `void` call sites (`push`, `resume`, retry timer). A failed `onDispatch` (e.g. the socket dropped mid-emit) is logged and retried with exponential backoff (`retryInterval` × 2ⁿ, capped at 30 s; reset on success). The queue is kept, so nothing is marked acknowledged. `close()`/`pause()` stops the retries. A rethrow here used to be an unhandled rejection that could terminate the server.

## Related

- [../auditor/AGENTS.md](../auditor/AGENTS.md) — auditor used for merge and replay
- [../../client/providers/AGENTS.md](../../client/providers/AGENTS.md) — C2S/S2C providers wire CD/CR
- [../../server/AGENTS.md](../../server/AGENTS.md) — server wires SR/SD per socket connection
