# Server socket actions (`src/server/actions/`)

Handlers for all client-to-server socket calls.

## Overview

Each file registers one socket action using `createServerActionHandler`. Actions are the request/response mechanism for one-off C2S calls (as opposed to subscriptions, which are persistent and push updates).

## Contents

### Read actions
- `getAction.ts` — `mxdbGetAction` — fetch records by id, narrowed to those the collection's `onQuery` gate lets the caller see
- `getAllAction.ts` — `mxdbGetAllAction` — fetch every record in a collection the `onQuery` gate lets the caller see
- `queryAction.ts` — `mxdbQueryAction` — paginated, sorted, filtered query. Forwards the request's `serverHints` to the collection's `onQuery` hook (see [../collections/AGENTS.md](../collections/AGENTS.md#server-query-hints-serverhints))
- `distinctAction.ts` — `mxdbDistinctAction` — distinct field values for a given field, drawn only from records the `onQuery` gate lets the caller see

### Sync actions
- `clientToServerSyncAction.ts` — `mxdbClientToServerSyncAction` — receives a `ClientDispatcherRequest`, delegates to `ServerReceiver.process()`, returns `MXDBSyncEngineResponse`. The most critical action — serialises concurrent syncs per record id to prevent lost-write races.
- `readReadableRecords.ts` — the read gate as a read: of the given record ids, the live records the caller may read, in ONE query per collection (`id in ids AND` the collection's `onQuery` gate via `useQueryGate`; a plain read with no gate; NO answer, logged, for a collection the database does not register — it fails closed: the change stream pushes and evicts nothing for it, sc-999), so the gate decision and the content are one snapshot (sc-682). The `ServerReceiver` (C2S) and each connection's change-stream fan-out (`ServerToClientSynchronisation`) use it; an id it does not return is never pushed and is evicted
- `rejectWritesOutsideReadGate.ts` — the C2S write gate: refuses an update or delete to a record whose stored version the caller may not read (creates are allowed); runs before the before-write hooks, whose runner skips the refused ids (`excludedIds`). Every refusal (unreadable, deleted, and — in the `ServerReceiver` — an edit to an id never held) gives the client the one `OUTSIDE_READ_GATE_REASON` from `common/sync-engine`, so the answer does not reveal whether the record exists; the cause is logged server-side only (sc-998)
- `assertValidSyncRequest.ts` — refuses a C2S request whose shape a client would not send (e.g. an operator object as a record id) before anything is mirrored or queried
- `runBeforeWriteHooksOnSyncStates.ts` — runs the collections' `onBeforeDelete` / `onBeforeUpsert` hooks on a C2S batch before it is persisted (see [../collections/AGENTS.md](../collections/AGENTS.md)); an amendment replaces the state's record and appends an `Updated` audit entry, in place, so the `ServerReceiver` pushes the amended record back to the client
- `reconcileAction.ts` — `mxdbReconcileAction` — reconciles a client's claimed state against the server; used on reconnect to detect divergence

### Internal
- `internalActions.ts` — re-exports action descriptor symbols from `src/common/internalActions.ts`
- `index.ts` — re-exports internal actions for wiring

## Architecture

`clientToServerSyncAction` uses a per-record promise chain to serialise concurrent C2S syncs. The `ServerReceiver` performs a read-merge-write cycle that is not atomic against MongoDB — without serialisation, two concurrent writes for the same record would both read the same baseline, merge independently, and the second write would clobber the first (losing audit entries). The serialisation chain is documented inline in `clientToServerSyncAction.ts`; do not modify the concurrency model without reading those comments.

Read actions (`getAll`, `query`) push their results through the S2C dispatch path rather than returning raw records — this keeps the `ServerDispatcher` filter current so subsequent change-stream events are correctly evaluated.

## Ambiguities and gotchas

- **Every read action applies the collection's `onQuery` gate** through `useQueryGate` (see [../collections/AGENTS.md](../collections/AGENTS.md#the-read-gate-onquery)). A new read action must too, or it reopens the hole the gate closes: a hand-crafted socket request reading what `query` withholds.
- **All read actions update the S2C filter** — they do not just return data. Bypassing them (e.g. querying MongoDB directly) will cause the SD filter to drift and clients will miss change-stream notifications.
- **`reconcileAction` vs `clientToServerSyncAction`** — reconcile is a lighter check that compares hashes without merging audits; C2S sync does the full merge-replay-persist cycle.

## Related

- [../AGENTS.md](../AGENTS.md) — parent server directory
- [../../common/internalActions.ts](../../common/internalActions.ts) — action descriptor symbols
- [../../common/sync-engine/AGENTS.md](../../common/sync-engine/AGENTS.md) — `ServerReceiver` used by C2S action
