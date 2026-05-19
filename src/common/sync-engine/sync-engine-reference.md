# Sync Engine (`src/common/sync-engine/`)

This is the **living reference** for the sync engine. It describes how the current implementation actually works — keep it up to date alongside code changes. If you are an agent picking this area up for the first time, read this document before editing anything in this folder.

---

## 1. What it is

A framework-agnostic module that implements the sync protocol between clients and the server. It owns **state** and **transitions**; the layers above it (React providers, sockets, IndexedDB, MongoDB) own **transport**.

It is made of four components — a dispatcher/receiver pair for each direction of data flow:

| Name | Direction | Lives on | Responsibility |
|------|-----------|----------|----------------|
| [`ClientDispatcher`](ClientDispatcher.ts) (CD) | Client -> Server | Client | Builds and dispatches C2S sync batches to the server |
| [`ServerReceiver`](ServerReceiver.ts) (SR) | Client -> Server | Server | Receives C2S batches, merges audits, replays, persists |
| [`ServerDispatcher`](ServerDispatcher.ts) (SD) | Server -> Client | Server | Filters and dispatches S2C push payloads to one client |
| [`ClientReceiver`](ClientReceiver.ts) (CR) | Server -> Client | Client | Applies S2C pushes to the local store |

One **SR + SD pair is created per connected client** on the server. One **CD + CR pair exists per client**.

---

## 2. Design rules

Hard constraints. Every component, flow, and model must respect them.

1. **Server-only audit merging.** Audit entries are only ever merged on the server (`ServerReceiver`). The client never merges audit trails — it only collapses its own local audit to a `Branched` anchor after the server acknowledges a successful sync, or collapses to the server's anchor when the `ClientReceiver` applies a server push (preserving any pending entries with ULID > anchor).
2. **Audit entries must never be lost.** No operation — sync, collapse, push, apply — may discard or overwrite audit entries. Collapsing to a `Branched` anchor preserves all entries whose ULID is greater than the anchor (pending mutations the server hasn't seen). Any failure path must leave the full audit trail intact.
3. **Failure-safe and self-healing.** A failure at any point — mid-dispatch, mid-merge, mid-apply, on either side of the transport — must leave the system recoverable. On restart or reconnect, components must re-derive correct state from what is persisted and converge without manual intervention.
4. **In-memory read layer.** Collections are persisted to SQLite, but an in-memory layer maintains an always-current copy that can be read synchronously. Callbacks such as `onPayloadRequest`, `onStart` (CD), `onRetrieve` / `onUpdate` (CR) are synchronous because they hit this in-memory layer. Only initial load and background persistence touch SQLite directly.
5. **Delete is final.** Once a record is deleted — on either side — it must never be resurrected. This is enforced at **every** boundary:
    - **CR**: refuses active cursors whose local state is a tombstone (see section 6.2). Also applies delete cursors even over pending local changes (delete-is-final overrides pending C2S).
    - **SD**: tracks `#deletedRecordIds` per collection and unconditionally adds every successfully-deleted id to it, regardless of whether the record was previously in the filter (see section 5.3). Change-stream deletes for unknown records still register tombstones.
    - **SR**: the source of truth — once a record materialises as deleted, the server emits deletion cursors to all connected SDs.
    - **Client store**: retains tombstones (audit trail with a trailing `Deleted` entry, no live record) so subsequent stale actives can be recognised and rejected.

---

## 3. Shared models

Defined in [models.ts](models.ts). The important ones:

### `MXDBRecordStatesRequest`
```typescript
interface MXDBRecordStatesByCollectionRequest { collectionName: string; recordIds: string[]; }
type MXDBRecordStatesRequest = MXDBRecordStatesByCollectionRequest[];
```

### `MXDBRecordStates`
Current state of records — active or deleted (tombstone):
```typescript
interface MXDBActiveRecordState<T extends Record = Record> { record: T; audit: AuditEntry[]; }
interface MXDBDeletedRecordState { recordId: string; audit: AuditEntry[]; }
type MXDBRecordStates<T extends Record = Record> = {
  collectionName: string;
  records: (MXDBActiveRecordState<T> | MXDBDeletedRecordState)[];
}[];
```

### `MXDBRecordCursors`
Lightweight cursors used by SD -> CR dispatches. Carries only `lastAuditEntryId`, not the full audit:
```typescript
interface MXDBActiveRecordCursor<T extends Record = Record> { record: T; lastAuditEntryId: string; hash?: string; }
interface MXDBDeletedRecordCursor { recordId: string; lastAuditEntryId: string; }
type MXDBRecordCursors<T extends Record = Record> = {
  collectionName: string;
  records: (MXDBActiveRecordCursor<T> | MXDBDeletedRecordCursor)[];
}[];
```

> **Hash on active cursors**: the SR attaches `hash` (materialised record hash) when it builds cursors to push to SDs. The SD uses this to skip dispatches where the filter already shows the client has an identical hash + `lastAuditEntryId`.

### `MXDBSyncEngineResponse`
```typescript
type MXDBSyncEngineResponse = { collectionName: string; successfulRecordIds: string[]; }[];
```
Used everywhere a component needs to report which ids it accepted.

### `MXDBUpdateRequest`
Passed by CD and CR to their `onUpdate` callback — what the local store should commit:
```typescript
type MXDBUpdateRequest<T extends Record = Record> = {
  collectionName: string;
  records?: { record: T; lastAuditEntryId: string }[];
  deletedRecordIds?: string[];
}[];
```

### `ServerDispatcherFilter`
The SD's per-client view of what records the client holds:
```typescript
interface ServerDispatcherFilter {
  collectionName: string;
  records: {
    id: string;
    /** Absent when the record is a *pending deletion* — delete sent but not yet confirmed. */
    hash?: string;
    lastAuditEntryId: string;
  }[];
  /** Ids the client has confirmed deleted — registered into #deletedRecordIds by updateFilter. */
  deletedRecordIds?: string[];
}
```

### `SyncPausedError`
Thrown by `ClientReceiver.process` when the CR is paused. The SD catches this specific type to distinguish "CR is paused — schedule retry" from "unexpected failure — propagate".

---

## 4. ClientDispatcher

See [ClientDispatcher.ts](ClientDispatcher.ts). Tests in [ClientDispatcher.tests.ts](ClientDispatcher.tests.ts).

### 4.1 Purpose

Runs on the client. Maintains a queue of records with pending local changes and periodically dispatches them to the SR. On start, sends a full snapshot of every record the client holds so the SD can build its filter.

### 4.2 Lifecycle

- **`start()`** — idempotent. Calls `#doStart()` which loops: read snapshot via `onStart` -> seed queue from snapshot -> dispatch -> on failure retry after `timerInterval`. Only once the initial dispatch succeeds does the regular timer loop take over.
- **`enqueue(item)`** — no-op if not started. If the `(collectionName, recordId)` pair is already queued **and** a dispatch is in-flight, the id is added to `#pendingReEnqueue` (see section 4.4). If already queued but not in-flight, it's a no-op (the existing entry will pick up the latest state at dispatch time). Otherwise the item is pushed to the queue and the timer is started if idle.
- **`stop()`** — increments `#epoch` (invalidating any in-flight coroutine), clears the timer, empties the queue, clears `#pendingReEnqueue`. If a dispatch was in-flight, resets `#inFlight`, calls `onDispatching(false)`, and resumes the `clientReceiver` — this prevents a stale coroutine's `finally` block from clobbering the new epoch's state. Disables `enqueue`.

### 4.3 Timer tick flow (`#timerTick`)

1. Groups the queue by collection into a `MXDBRecordStatesRequest`.
2. Calls `onPayloadRequest` (synchronous) -> `MXDBRecordStates`.
3. **Drop-filter**: filters `#queue` down to only entries whose state still exists in the returned `MXDBRecordStates`. Records that have disappeared locally (e.g. deleted by an incoming S2C push while sitting in the queue) are dropped — otherwise they would sit in the queue forever.
4. Captures `#epoch`, sets `#inFlight = true`.
5. Calls `#buildRequest(states)` which hashes each active record and wraps everything into a `ClientDispatcherRequest`. All audit entries including `Branched` are included; the SR strips `Branched` entries before merging.
6. Calls `onDispatching(true)`, `clientReceiver.pause()`, then `onDispatch(request)`.
7. On success with matching epoch, calls `#processSuccessResponse` which:
    - Builds a `MXDBUpdateRequest` from successful ids and calls `onUpdate`. Active records use the **insertion-order last** audit entry id as `lastAuditEntryId` — see section 4.5 below — **not** the max ULID.
    - Removes successfully-dispatched items from `#queue`.
    - For each entry in `#pendingReEnqueue` whose id is in `successfulRecordIds`, re-queues that record (see section 4.4).
8. `finally`: only if `#epoch` still matches the dispatch epoch: `#inFlight = false`, `onDispatching(false)`, `clientReceiver.resume()`. If epoch has changed (stop() was called mid-flight), the stale coroutine skips all shared-state mutations.
9. On success with non-empty queue, restarts the timer. On failure, restarts the timer to retry.

### 4.4 `#pendingReEnqueue` — the in-flight race

**Scenario**: `enqueue(X)` is called while X is already being dispatched. A naive implementation would no-op (X is already in the queue), but `#processSuccessResponse` then removes X from the queue after success, **silently losing** the update that triggered the re-enqueue.

**Fix**: when `enqueue` sees a duplicate **and** `#inFlight` is true, the id goes into `#pendingReEnqueue`. After success, any id in this set is re-queued for the next dispatch.

Regression test: [ClientDispatcher.tests.ts](ClientDispatcher.tests.ts) — "re-enqueues a record whose enqueue arrived while it was in-flight".

### 4.5 `lastAuditEntryId` — insertion order, not max ULID

When `#processSuccessResponse` builds the `MXDBUpdateRequest` for successful records, it uses `state.audit[state.audit.length - 1].id` — **not** `getLastEntryId` (max ULID).

**Why**: after `collapseToAnchor`, the audit can look like:
```
[Branched(server-ulid-NEW), Updated(client-ulid-OLD)]
```
The Branched anchor's id (server-generated) can be lexicographically *greater* than the client-generated Updated entries that follow it. Picking the max-ULID entry would return the anchor, leaving the pending Updated entries stranded after the collapse point — the audit would never become branch-only again, and the record would sit in C2S purgatory forever.

Using insertion order is correct because `collapseToAnchor` always places the `Branched` anchor at the front.

Regression test: [ClientDispatcher.tests.ts](ClientDispatcher.tests.ts) — "uses the last audit entry (insertion order) for lastAuditEntryId, not the max ULID".

### 4.6 Epoch guard — stop/start safety

The `#epoch` counter ensures that a stale in-flight coroutine (from a previous `start()` cycle) cannot mutate shared state after `stop()` + `start()` creates a new epoch:

- `stop()` increments `#epoch`, eagerly resets `#inFlight` and dispatching/pause state.
- Every `await` boundary in `#doStart` and `#timerTick` checks the captured epoch against the current `#epoch`. If they differ, the coroutine exits immediately.
- The `finally` block only resets `#inFlight` / `onDispatching` / `resume()` when the captured epoch still matches — preventing clobber of the new epoch's state.

### 4.7 Props

```typescript
interface ClientDispatcherProps {
  clientReceiver: ClientReceiver;
  onPayloadRequest<T>(request: MXDBRecordStatesRequest): MXDBRecordStates<T>;
  onDispatching(isDispatching: boolean): void;
  onDispatch(payload: ClientDispatcherRequest): Promise<MXDBSyncEngineResponse>;
  onUpdate(updates: MXDBUpdateRequest): void;
  onStart(): MXDBRecordStates;
  timerInterval?: number; // default 250ms
}
```

---

## 5. ServerDispatcher

See [ServerDispatcher.ts](ServerDispatcher.ts). Tests in [ServerDispatcher.tests.ts](ServerDispatcher.tests.ts).

### 5.1 Purpose

Runs on the server, one instance per connected client. Owns a per-client filter (`#filter`) and a tombstone set (`#deletedRecordIds`). Given an incoming push from the SR (or change stream), it compares against the filter, skips anything the client is already up to date on, and dispatches only the delta to the CR.

### 5.2 `addToFilter` — authoritative vs change-stream pushes

Each `push()` call carries an `addToFilter` flag (default `true`):

- **`true` (authoritative)**: SR merge results, getAll/query/get/subscription paths. On successful dispatch, the record is added to or updated in `#filter`. This bootstraps records the CR hasn't seen before.
- **`false` (change-stream)**: MongoDB change-stream fan-out. On dispatch, cursors whose record is NOT already in `#filter` are **dropped** — the CR hasn't acknowledged the record, so a change-stream event cannot bootstrap it. However, change-stream deletes for unknown records still register tombstones in `#deletedRecordIds` to block stale active cursors from leaking through later.

The flag is tracked per queued batch and OR'd together during squash (authoritative wins).

### 5.3 Squash (`#squashQueue`)

All queued batches are squashed into a single per-collection map of tagged cursors before dispatch:

- **Delete cursors always beat active cursors** (delete-is-final).
- Between two active cursors, the one with the later `lastAuditEntryId` wins. On equal `lastAuditEntryId`, the **later-enqueued** cursor wins (most recent oplog position = freshest record state).
- `addToFilter` flags OR together: if any batch for a record wanted to add it to the filter, the merged cursor carries `addToFilter=true`.

### 5.4 Core dispatch flow (`#dispatch`)

1. Snapshot `#queue.length`, squash via `#squashQueue`.
2. For each cursor, compare against `#filter` and `#deletedRecordIds`:
    - **Confirmed-deleted id** (in `#deletedRecordIds`): **drop** — delete is final.
    - **Delete cursor**:
        - Unknown to filter + `addToFilter=false`: drop the cursor but register the id in `#deletedRecordIds` (blocks future stale actives).
        - Unknown to filter + `addToFilter=true`: send (authoritative delete for record CR acquired via another route).
        - Filter record is a pending deletion (hash absent): pick the later `lastAuditEntryId` between cursor and filter.
        - Normal filter record: send the deletion.
    - **Active cursor**:
        - Unknown to filter + `addToFilter=false`: drop (change-stream cannot bootstrap).
        - Unknown to filter + `addToFilter=true`: send (new record).
        - Filter record is pending deletion: re-send the pending delete instead.
        - Filter `hash` + `lastAuditEntryId` match cursor: **skip** (client up to date).
        - Cursor `lastAuditEntryId` < filter `lastAuditEntryId`: **drop** (stale — prevents retry loops on outdated cursors).
        - Otherwise: send.
3. If the fresh request is empty, trim queue and return.
4. Set `#inFlight = true`, call `onDispatch(freshRequest)`.
5. On success, update `#filter` and `#deletedRecordIds` using `successfulRecordIds`:
    - **Successful delete**: remove from `#filter.records`, add to `#deletedRecordIds`.
    - **Unsuccessful delete**: mark filter record as pending deletion (clear hash, keep `lastAuditEntryId`).
    - **Successful active** (with `addToFilter=true` or already in filter): update or add the filter record with cursor's hash and `lastAuditEntryId`.
6. Trim `#queue` by snapshot length. Re-queue failed records (grouped by their `addToFilter` flag).
7. `finally`: `#inFlight = false`.
8. **On success**: if `#queue` non-empty and not paused, recurse.
    **On `SyncPausedError`**: start `#retryTimer` with `retryInterval` (default 250ms).
    **On any other error**: propagate.

### 5.5 `#deletedRecordIds` is populated unconditionally

**Regression**: there used to be a `wasInFilter` gate that only added an id to `#deletedRecordIds` if the record had previously been in the filter. This was removed.

**Why**: clients can acquire a record via routes the SD didn't see (bootstrap, initial seed, a concurrent S2C push that originated elsewhere). If the client then deletes the record and the delete succeeds, the SD *must* remember that — otherwise a subsequent stale active cursor arriving via squash or broadcast would slip through the filter and be dispatched to the CR, which would then have to refuse resurrection. Better to catch it at the SD.

Additionally, change-stream deletes for records the SD hasn't seen (`addToFilter=false`) still register tombstones — this prevents stale active cursors queued before the delete from leaking through.

Regression test: [ServerDispatcher.tests.ts](ServerDispatcher.tests.ts) — "successful delete for a record never seen in filter still populates deletedRecordIds".

### 5.6 `updateFilter` — SR mirror seeding

`updateFilter(filters)` is called by the SR at the start of `process()` (before any `await`) to synchronously seed the filter with the client's claimed state. This ensures that change-stream events racing with the C2S call are evaluated against an up-to-date filter when the SD resumes.

Additionally, if a client reports an active record (hash present) but `#deletedRecordIds` has a premature tombstone for that id (e.g. a change-stream delete arrived before the CD's initial dispatch), the tombstone is cleared — preventing the subsequent authoritative delete from being swallowed.

### 5.7 Pause / resume

`pause()` sets `#isPaused = true`. `resume()` clears it and calls `#dispatch` if nothing is in-flight and no retry timer is running. `push()` always adds to the queue; it only calls `#dispatch` when not paused, not in-flight, and no retry timer is running.

### 5.8 Props

```typescript
interface ServerDispatcherProps {
  onDispatch<T>(payload: MXDBRecordCursors<T>): Promise<MXDBSyncEngineResponse>;
  retryInterval?: number; // default 250ms
}
```

---

## 6. ClientReceiver

See [ClientReceiver.ts](ClientReceiver.ts). Tests in [ClientReceiver.tests.ts](ClientReceiver.tests.ts).

### 6.1 Purpose

Runs on the client. Accepts `MXDBRecordCursors` pushes from the SD, filters them against the local store, and commits the accepted changes via `onUpdate`.

### 6.2 `process` flow

1. Throws `SyncPausedError` immediately if paused — the SD catches this and schedules a retry.
2. Build a `MXDBRecordStatesRequest` from the payload; call `onRetrieve` -> current local states (active or tombstone).
3. For each cursor, look up its local state and decide:
    - **No local state + active cursor** -> accept (new record).
    - **No local state + delete cursor** -> no-op, but include the id in `successfulRecordIds` so the SD clears it from its queue. Logged at warn.
    - **Local state is a tombstone + active cursor** -> **refuse**. This is the delete-is-final enforcement point on the CR. The client has just deleted this record locally; the active cursor was dispatched before the local delete was written (or while it was still in-flight through the network). The client's local tombstone wins. Logged at debug — this is an expected race, not a bug.
    - **Local state is a tombstone + delete cursor** -> already consistent. Include the id in `successfulRecordIds`.
    - **Local state has pending local changes (not branch-only) + delete cursor** -> **accept the delete**. Delete-is-final overrides pending C2S changes — once the server tombstones a record, the client's pending updates are moot (the SR would reject them anyway). Writes a local tombstone.
    - **Local state has pending local changes (not branch-only) + active cursor** -> skip. The CD will merge via C2S.
    - **Local state is branch-only + active cursor whose `lastAuditEntryId` is older than the local branch ULID** -> skip (stale). Delete cursors bypass this staleness check — delete-is-final overrides staleness.
    - **Local state is branch-only + cursor is newer** -> accept.
4. Build an `MXDBUpdateRequest` from the accepted cursors and call `onUpdate`. Merge any "no local state delete" and "tombstone delete" ids into the returned `MXDBSyncEngineResponse`.

Regression tests for the delete-is-final cases: [ClientReceiver.tests.ts](ClientReceiver.tests.ts) — "refuses to resurrect a locally-tombstoned record when an active cursor arrives" and "treats a delete cursor against a local tombstone as already-consistent (success, no resurrection)".

### 6.3 Pause / resume

`pause()` is called by the CD before each `onDispatch` to prevent an S2C push from being processed while a C2S dispatch is in-flight (avoids cross-flow races). `resume()` is called after the dispatch completes.

### 6.4 Props

```typescript
interface ClientReceiverProps {
  onRetrieve<T>(request: MXDBRecordStatesRequest): MXDBRecordStates<T>;
  onUpdate(updates: MXDBUpdateRequest): MXDBSyncEngineResponse;
}
```

---

## 7. ServerReceiver

See [ServerReceiver.ts](ServerReceiver.ts). Tests in [ServerReceiver.tests.ts](ServerReceiver.tests.ts).

### 7.1 Purpose

Runs on the server, one instance per connected client. Given a `ClientDispatcherRequest`, it merges the incoming audits with the server's current audits, replays to materialise the new state, persists, and pushes disparity cursors to the originator's SD (other SDs are notified via the MongoDB change stream).

### 7.2 `process` flow

1. `serverDispatcher.pause()` — holds S2C pushes while processing.
2. **Mirror filter** (synchronous, before any `await`): build `ServerDispatcherFilter[]` from the client's claimed state (`#buildMirrorFilter`) and call `serverDispatcher.updateFilter(filters)`. This seeds the SD's filter with the client's current hashes and max audit entry ids so that change-stream events racing with this C2S call are evaluated against an accurate filter when we later resume.
3. Retrieve current server state via `onRetrieve` for every record in the request.
4. For each incoming record, strip `Branched` entries from the client audit:
    - **No entries remain** (branched-only):
        - Has `hash` (active): compare with server state for disparity detection. No merge needed. Included in `successfulRecordIds`.
        - No `hash` (deleted): client deletion for absent server record. Already consistent.
    - **Entries remain** -> merge with server audit via `auditor.merge()`, replay via `replayHistoryEndState` -> materialised state (active or deleted). If merge/replay throws, log and skip that record.
    - **New record** (no server state, first entry is `Created`): use client entries directly (no merge needed).
    - **Tombstoned server state**: NOT a short-circuit. Entries are still merged into the audit (replay keeps `live = undefined` after a Delete — post-delete updates change the audit length without resurrecting the record).
5. Call `onUpdate(states)` to persist all merged/new results. Returns `MXDBSyncEngineResponse` of successfully-persisted ids.
6. Collect `successfulRecordIds` = persisted ids + branched-only ids.
7. Build disparity push payload by comparing merged/server state against what the client sent:
    - **Branched-only active, server hash differs from client hash** -> active cursor in payload.
    - **Branched-only active, server is deleted but client thinks active** -> delete cursor.
    - **Persisted active, merged hash differs from client hash** -> active cursor.
    - **Persisted as deleted, client thought active** -> delete cursor.
8. Push disparities via `serverDispatcher.push(payload)` (authoritative, `addToFilter=true`). The SD's filter deduplicates — if the client's mirror matches, the push is a no-op.
9. `finally`: `serverDispatcher.resume()`.
10. Return the `MXDBSyncEngineResponse`.

### 7.3 Why the mirror filter must be synchronous

The mirror filter (step 2) runs before any `await`. If it were deferred until after `onRetrieve`, a change-stream event could arrive on the SD's queue with the old filter state, causing a stale cursor to be dispatched to the CR (or a needed cursor to be suppressed). By seeding the filter synchronously, all subsequent SD decisions (including those that queue during our `await` calls) use the client's up-to-date claimed state.

### 7.4 Broadcast scope

The SR pushes disparity cursors only to the **originator's SD** (via `serverDispatcher.push`). Other connected clients are notified of the same state change via the MongoDB change stream, which triggers separate `push(cursors, addToFilter=false)` calls on their respective SDs. This keeps the broadcast path simple and avoids the SR needing references to all SDs.

---

## 8. Flow summary

```
                                          +------------------+
                                          |     Server       |
                                          |                  |
   +----------+   C2S (ClientDispatch)    |  +-----------+   |
   |  Client  |  ---------------------->  |  |    SR     |   |
   |          |                           |  +-----+-----+   |
   |   +--+   |                           |        |         |
   |   |CD|   |                           |    merge+        |
   |   +--+   |                           |    replay+       |
   |          |                           |    persist        |
   |   +--+   |                           |        |         |
   |   |CR|   |   S2C (ServerDispatch)    |        v         |
   |   +--+   |  <----------------------  |  +-----------+   |
   +----------+   disparity push to own   |  |    SD     |   |
                  SD; change stream fans   |  | (per      |   |
                  out to other SDs         |  | client)   |   |
                                          |  +-----------+   |
                                          +------------------+
```

- **CD -> SR**: hashes records, builds `ClientDispatcherRequest` with full audit (including `Branched`), awaits `MXDBSyncEngineResponse`, commits `onUpdate` for successful ids (collapses audit to anchor).
- **SR -> own SD**: seeds mirror filter synchronously, then pushes disparity cursors after merge.
- **Change stream -> all SDs**: MongoDB change-stream events fan out to every connected SD via `push(cursors, addToFilter=false)`.
- **SD -> CR**: filters cursors against its per-client view (hash + ULID + tombstone checks), dispatches only the delta.
- **CR -> store**: accepts via `onUpdate` after delete-is-final and staleness checks. The store's `upsert('branched', anchorUlid)` collapses the local audit to a `Branched` anchor while preserving pending entries with ULID > anchor.

---

## 9. Testing

- **Unit tests** for each component in `*.tests.ts` siblings. Run with `npx vitest run src/common/sync-engine/`.
- **Stress test** in [syncEngine.stress.tests.ts](syncEngine.stress.tests.ts) — spins up 12 clients doing creates/updates/deletes for 30s with injected network failures, then asserts all clients converge to server state within the settle window. Covers the full four-component interaction that individual unit tests cannot.

When you touch any file in this folder:
1. Run the affected component's unit tests.
2. Run the stress test. A single pass is not enough — run it **multiple times** (5+) if you touched any race-sensitive code (CD reenqueue/epoch, SD filter, CR tombstone checks, SR broadcast).

### 9.1 Invariants covered by unit tests

If a regression causes a stress-test flake, check if one of these unit tests would have caught it:

| Invariant | Test file | Test name |
|---|---|---|
| Delete-is-final (CR refuses resurrection) | `ClientReceiver.tests.ts` | "refuses to resurrect a locally-tombstoned record when an active cursor arrives" |
| Delete against tombstone is no-op success | `ClientReceiver.tests.ts` | "treats a delete cursor against a local tombstone as already-consistent (success, no resurrection)" |
| `#deletedRecordIds` populated unconditionally | `ServerDispatcher.tests.ts` | "successful delete for a record never seen in filter still populates deletedRecordIds" |
| Unknown-record deletes are forwarded, not swallowed | `ServerDispatcher.tests.ts` | "sends delete cursors through even when record is unknown to filter" |
| `#deletedRecordIds` blocks active cursors (filterItem null branch) | `ServerDispatcher.tests.ts` | "blocks active cursors when id is in deletedRecordIds and filterItem is null" |
| `delete-wins` in squash | `ServerDispatcher.tests.ts` | "delete wins over update in squash" |
| CD `#pendingReEnqueue` in-flight race | `ClientDispatcher.tests.ts` | "re-enqueues a record whose enqueue arrived while it was in-flight" |
| CD drops queue entries whose state disappeared | `ClientDispatcher.tests.ts` | "drops queue entries whose state has disappeared before dispatch" |
| CD uses insertion-order `lastAuditEntryId`, not max ULID | `ClientDispatcher.tests.ts` | "uses the last audit entry (insertion order) for lastAuditEntryId, not the max ULID" |

---

## 10. Side notes

### 10.1 MongoDB change stream — deleted record propagation

The MongoDB change stream handler filters change events before passing them to `onChange`: once a record is deleted, only the original `Deleted` transition is propagated; subsequent mutations to a tombstoned record's audit are silently absorbed. This prevents "resurrection pushes" from ever reaching the SD layer.

### 10.2 `collapseToAnchor` fallback behaviour

When the anchor ULID is not found in the local audit entries (e.g. the anchor came from the server and was never in our local entries), `collapseToAnchor` preserves all non-Branched entries whose ULID is lexicographically greater than the anchor. This ensures pending mutations the server hasn't seen are never dropped, even when the S2C push delivers a branch anchor the client doesn't recognise.
