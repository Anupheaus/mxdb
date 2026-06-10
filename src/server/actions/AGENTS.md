# Server socket actions (`src/server/actions/`)

Handlers for all client-to-server socket calls.

## Overview

Each file registers one socket action using `createServerActionHandler`. Actions are the request/response mechanism for one-off C2S calls (as opposed to subscriptions, which are persistent and push updates).

## Contents

### Read actions
- `getAction.ts` — `mxdbGetAction` — fetch a single record by id
- `getAllAction.ts` — `mxdbGetAllAction` — fetch all records in a collection
- `queryAction.ts` — `mxdbQueryAction` — paginated, sorted, filtered query. Forwards the request's `serverHints` to the collection's `onQuery` hook (see [../collections/AGENTS.md](../collections/AGENTS.md#server-query-hints-serverhints))
- `distinctAction.ts` — `mxdbDistinctAction` — distinct field values for a given field

### Sync actions
- `clientToServerSyncAction.ts` — `mxdbClientToServerSyncAction` — receives a `ClientDispatcherRequest`, delegates to `ServerReceiver.process()`, returns `MXDBSyncEngineResponse`. The most critical action — serialises concurrent syncs per record id to prevent lost-write races.
- `reconcileAction.ts` — `mxdbReconcileAction` — reconciles a client's claimed state against the server; used on reconnect to detect divergence

### Internal
- `internalActions.ts` — re-exports action descriptor symbols from `src/common/internalActions.ts`
- `index.ts` — re-exports internal actions for wiring

## Architecture

`clientToServerSyncAction` uses a per-record promise chain to serialise concurrent C2S syncs. The `ServerReceiver` performs a read-merge-write cycle that is not atomic against MongoDB — without serialisation, two concurrent writes for the same record would both read the same baseline, merge independently, and the second write would clobber the first (losing audit entries). The serialisation chain is documented inline in `clientToServerSyncAction.ts`; do not modify the concurrency model without reading those comments.

Read actions (`getAll`, `query`) push their results through the S2C dispatch path rather than returning raw records — this keeps the `ServerDispatcher` filter current so subsequent change-stream events are correctly evaluated.

## Ambiguities and gotchas

- **All read actions update the S2C filter** — they do not just return data. Bypassing them (e.g. querying MongoDB directly) will cause the SD filter to drift and clients will miss change-stream notifications.
- **`reconcileAction` vs `clientToServerSyncAction`** — reconcile is a lighter check that compares hashes without merging audits; C2S sync does the full merge-replay-persist cycle.

## Related

- [../AGENTS.md](../AGENTS.md) — parent server directory
- [../../common/internalActions.ts](../../common/internalActions.ts) — action descriptor symbols
- [../../common/sync-engine/AGENTS.md](../../common/sync-engine/AGENTS.md) — `ServerReceiver` used by C2S action
