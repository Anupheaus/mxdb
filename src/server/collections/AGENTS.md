# Server collections API (`src/server/collections/`)

`extendCollection` and the server-side `useCollection` accessor.

## Overview

`extendCollection` is the server's primary extension point: it attaches lifecycle hooks and optional seeding to a collection. `useCollection` provides a read/write accessor for use inside hooks and actions.

## Contents

- `extendCollection.ts` — `extendCollection(collection, hooks)` — registers hooks in a module-level registry; `ServerDbCollectionEvents` reads them when wiring change-stream callbacks
- `useCollection.ts` — `useCollection(collectionName)` — returns `{ collection, getAll, get, find, query, upsert, remove, distinct, onChange, removeOnChange }`; use inside `onAfter*` hooks for cross-collection cascades
- `runBeforeUpsertHook.ts` — `runBeforeUpsertHook({ collection, records, existingRecords })` — runs `onBeforeUpsert` on copies of the records about to be written (classifying inserts vs updates) and returns the copies to write; internal, called by `ServerDbCollection.upsert` and the C2S sync write path
- `runBeforeDeleteHook.ts` — `runBeforeDeleteHook({ collection, recordIds, getStoredIds })` — runs `onBeforeDelete` for the ids that are still stored; internal, called by `ServerDbCollection.remove` and the C2S sync write path
- `useQueryGate.ts` — `useQueryGate(collection)` — binds the collection's `onQuery` gate to the current caller; `gateRequest(request)` for queries and `distinct`, `getGateFilters()` for reads that are not a query (`get`, `getAll`). Internal, used by every read action and subscription; types in `query-gate-models.ts`
- `index.ts` — re-exports `extendCollection` and `useCollection` (the hook runners are internal and deliberately not exported)

## Available hooks

| Hook | When | Notes |
|------|------|-------|
| `onBeforeUpsert({ records, insertedIds, updatedIds })` | Before write, on originating instance — server writes (`useCollection().upsert`, record hooks, seeding) **and** synced client writes | Validation (throw to reject) or amending the records in place |
| `onAfterUpsert({ records, insertedIds, updatedIds })` | After change stream, on all instances | Use for cascades |
| `onBeforeDelete({ recordIds })` | Before write, on originating instance — server `remove` **and** synced client deletes | Validation (throw to reject) or cleaning up references; the records are still readable |
| `onAfterDelete({ recordIds })` | After change stream, on all instances | Use for cascades |
| `onBeforeClear({ collectionName })` | Before `clear()`, on originating instance | Throw to reject |
| `onAfterClear({ collectionName })` | After clear, on originating instance only | Not change-stream driven |
| `onSeed(seedWith)` | At startup if `shouldSeedCollections: true` | — |
| `onQuery({ request, userId })` | Before EVERY client read — `query`, `get`, `getAll`, `distinct` actions and the query, getAll and distinct subscriptions (see "The read gate" below) | Security scoping; interpret `serverHints` (see below) |

## Before-write hooks (`onBeforeUpsert` / `onBeforeDelete`)

Both run **before anything is persisted**, on the instance performing the write, for every write path: server-side writes (`ServerDbCollection.upsert` / `remove`, i.e. `useCollection` and `createUseRecord(s)`) and client writes arriving through C2S sync (`actions/runBeforeWriteHooksOnSyncStates.ts`).

- **Once per write, only for real changes.** `onBeforeUpsert` gets only the records that are new or differ from the stored version (an unchanged rewrite, or a client re-sending a change the server already has, does not fire it). `onBeforeDelete` gets only ids that are still stored (deleting a missing or already-deleted record does not fire it). A server-side write fires the hook once with every record in the batch (all-or-nothing); a synced client batch fires it once **per record** (a payload of one), so a rejection can be pinned on exactly that record.
- **Amending records.** `onBeforeUpsert` receives copies it may mutate in place (the caller's objects are untouched); the amended copies are what gets written. The amendment is audited: server writes diff it into the audit as usual, and on the sync path an `Updated` audit entry is appended to the merged audit (its id is minted by `auditor.updateAuditWithAfterLatest`, so it sorts after the client's entries even when the client's clock runs ahead) and the `ServerReceiver` pushes the amended record back to the client that sent the change, so it converges.
- **Telling the user about an amendment.** An amendment is silent unless `onBeforeUpsert` returns notes: `return [{ id, note }]` with a plain-English `note` for each record it put fields back on. On the sync path a note for a record the hook really changed (and did not reject) goes back in the sync response's `amendedRecords` and reaches the app through `MXDBSync`'s `onSyncAmended`; the rest of the change still saves. Notes are ignored for server-side writes (`runBeforeUpsertHook` returns them as `amendmentNotes`, `ServerDbCollection.upsert` drops them).
- **Rejecting a server write.** A hook that throws rejects the whole write: nothing is persisted and the call rejects with the hook's error.
- **Rejecting a synced client write (reject and revert).** A hook that throws rejects only that record; the rest of the batch persists. The record is still acknowledged (so the client stops resending it) and reported back in the sync response's `rejectedRecords` with the thrown message as `reason`, which the client hands the app via `MXDBSync`'s `onSyncRejected`. The device is brought back in line: a rejected **update** keeps the client's audit entries and gets a server `Updated` entry restoring the stored record, which is pushed back so the device reverts; a rejected **create** keeps the client's `Created` entry, gets a `Deleted` entry and is never stored live — the device drops it; a rejected **delete** is not applied on the server (the record and its audit are untouched) and stays deleted on the device, because restoring a deleted record is not supported — surface the reason to the user. Server-authored entries always sort after the client's, even from a client whose clock runs ahead. Throw `Error`s with user-presentable messages.
- **Context.** The hooks run in the writer's context (ambient db, socket/user for client writes), so `useCollection` inside them targets the same database. Do not upsert the same collection from its own `onBeforeUpsert` (infinite recursion).

## The read gate (`onQuery`)

`onQuery` is the collection's read gate: it narrows every path a client can read the collection through, so a hand-crafted socket request for `get`, `getAll` or `distinct` cannot return what `query` would withhold. Every read action and subscription binds it through `useQueryGate`:

- **`query`, `distinct`** (actions and subscriptions) — the client's request is passed to `onQuery` and the rewritten request is what runs.
- **`get`, `getAll`** (action, and the getAll subscription) — `onQuery` is called with an empty request; the filters it returns are the gate. `get` fetches `{ $and: [{ id: { $in: ids } }, gate] }`, so it never returns a record that was not asked for, whatever the gate does with `id`. A gate that returns no filters (or nothing) leaves the read unnarrowed and the plain `get`/`getAll` path runs.
- **`reconcile`** reports a stored record the client may no longer read exactly as it reports a deleted one (so the answer never reveals which ids exist outside the gate), but EVICTS it rather than deleting it: a delete would tombstone it on the device, and a tombstone refuses the record for good (delete-is-final) even once the gate lets it back in. The getAll subscription follows the same rule: a record that leaves the gate is dropped from the snapshot but only pushed as a delete if it was really deleted.
- **Subscriptions resolve the gate once, at subscribe time**, because their change handlers run from the change stream with no request context. A change in what the caller may see (a new role, a reassigned record) applies from the next subscribe.

Write a gate as a pure rewrite of the request — AND your scope onto `request.filters` rather than replacing an `id` filter — and have it return a filter that matches nothing for a caller it cannot resolve.

**C2S sync** consults the gate too (`actions/filterReadableRecordIds.ts` → the `ServerReceiver`'s `onFilterReadable`): a sync request naming a record the caller may not read is never answered with its content, and does not subscribe the client to its changes (see `common/sync-engine/AGENTS.md`, "The read gate").

**Writes are gated by it too.** A synced update or delete to a record whose STORED version is outside the caller's gate is refused before it is persisted (`actions/rejectWritesOutsideReadGate.ts`) and reported in `rejectedRecords`; any change to a DELETED record (its audit is a tombstone) is refused too, since its gate cannot be judged and a client `Restored` entry would resurrect the server's last content. The refused state is replaced by what the server holds, so only the stored record is ever pushed back, and only if the caller may read it. Creating a record under an id the server has never held is allowed (a `disableAudit` collection keeps no tombstones). Anything that must legitimately change a record outside the caller's read scope belongs in a server action.

**Change-stream fan-out applies the gate too** (sc-584). Each connection's `ServerToClientSynchronisation` gets a `filterReadable` bound to that connection's own async context (`startAuthenticatedServer`), so every change-stream upsert is checked against the connection's current gate: a record it may read is pushed; a record it holds but may no longer read (reassigned, a capability removed) is EVICTED — the device drops its copy without a tombstone, and an authoritative read under the new gate brings it back; a record it never held is not sent. A gate that throws pushes and evicts nothing (logged). The C2S start-up sweep does the same for everything a device holds when it reconnects.

**Evictions** (`isEviction` on a delete cursor) never carry content and are answered for every id the caller may not read — live, deleted or never stored — so neither a sync probe nor reconcile tells those cases apart. A device with unsynced changes to the record declines the eviction; its changes reach the server (which judges them) and the next sweep evicts it.

## Server query hints (`serverHints`)

`serverHints` is an optional, strongly-typed, **server-only** metadata bag on `QueryProps` / `QueryRequest` (defined in `common/models/collectionsModels.ts`). It is the channel by which a caller passes *intent* to a collection's `onQuery` hook — it is **never applied to the client's local SQLite query, and never forwarded into the server's MongoDB query**. It does nothing on its own; only an `onQuery` hook gives it meaning.

**Round trip:**
1. A caller sets `serverHints` on a query — `query(...)` / `useQuery(...)` on the client, or a server-side query.
2. The server entry points (`queryAction.ts`, `querySubscription.ts`, via `useQueryGate`) package it into the `request` passed to `onQuery({ request, userId })`.
3. `onQuery` reads `request.serverHints` and returns a modified `QueryProps` (extra filters, sorts, pagination, `getAccurateTotal`) to act on the hint.
4. `serverHints` is then dropped — only the effective `filters` / `sorts` / `pagination` / `getAccurateTotal` drive the actual fetch. The hint object never reaches storage.

**Typing:** `QueryProps<RecordType, Hints>` and `QueryRequest<RecordType, Hints>` accept an optional second generic for a typed hint shape; it defaults to `ServerQueryHints` (`{ [key: string]: unknown }`). Inside `onQuery` the request is `QueryProps<any>`, so narrow/validate `request.serverHints` before trusting it.

**Example — interpret a hint and apply security scoping:**
```ts
interface ScheduleRunHints { latestPerSchedule?: boolean }

extendCollection(scheduleRunsCollection, {
  onQuery({ request, userId }) {
    // Security scoping always applies — never trust the client's filters alone.
    const scoped = { ...request, filters: { ...request.filters, ownerId: userId } };
    // Interpret a hint: "give me only the most recent run".
    const hints = request.serverHints as ScheduleRunHints | undefined;
    if (hints?.latestPerSchedule) return { ...scoped, sorts: { startedAt: 'desc' }, pagination: { limit: 1 } };
    return scoped; // return void/undefined to use the request unchanged
  },
});

// caller (client component)
const { records } = await query({ filters: { scheduleId }, serverHints: { latestPerSchedule: true } });
```

## Architecture

`extendCollection` may be called before `startServer` — hook registration is fire-and-forget into a module-level `Map`. The registry is read by `ServerDbCollectionEvents` during `startServer` when it wires change-stream callbacks per collection.

## Ambiguities and gotchas

- **`onAfter*` (upsert/delete) run on every instance watching the change stream** — not just the one that originated the write. Do not rely on request-scoped context (user, socket) inside them; use `onBefore*` for that.
- **`onAfterClear` is not change-stream driven** — it runs only on the instance that performed the clear. This asymmetry is intentional and documented in `README.md`.
- **`onBeforeClear` / `onAfterClear`** are run by `ServerDbCollection.clear()` itself (before and after the delete), on the instance performing the clear only.
- **`useCollection` inside hooks** — `onAfter*` hooks run outside socket request context, with the ambient database set to the `ServerDb` that observed the change (whatever context that database was built in). Use `useCollection` for cross-collection reads/writes; do not attempt to access user/socket context here.
- **`serverHints` is inert without an `onQuery` hook** — if no hook interprets them, the hints are silently ignored (they never reach the client SQLite query or the server Mongo query). A hint that "does nothing" usually means the `onQuery` hook isn't registered or isn't reading `request.serverHints`.

## Related

- [../AGENTS.md](../AGENTS.md) — parent server directory
- [../providers/db/AGENTS.md](../providers/db/AGENTS.md) — `ServerDbCollectionEvents` invokes hooks
- [../subscriptions/AGENTS.md](../subscriptions/AGENTS.md) — subscriptions also use `useCollection`
