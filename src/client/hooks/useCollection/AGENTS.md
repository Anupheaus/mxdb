# `useCollection` hook (`src/client/hooks/useCollection/`)

Primary collection API for React components: imperative CRUD operations and reactive live-update hooks.

## Overview

`useCollection(collection)` returns an object with two kinds of members: **imperative** async functions (used in event handlers, effects) and **reactive** hooks (subscribed to live updates). All imperative write operations hit local SQLite first (optimistic); the C2S sync pipeline picks them up on its next tick and dispatches to the server.

## Contents

### Entry points
- `useCollection.ts` / `index.ts` — composes all `create*` factories into the return value of `useCollection()`

### Imperative operations
- `createGet.ts` — `get(id)` — fetch a single record by id
- `createGetAll.ts` — `getAll()` — fetch all records
- `createFind.ts` — `find(filters)` — filtered fetch without pagination
- `createQuery.ts` — `query(request)` — paginated, sorted, filtered fetch
- `createDistinct.ts` — `distinct(field, filters?)` — distinct field values
- `createUpsert.ts` — `upsert(record)` — insert or update; appends an audit `Updated` entry and enqueues a C2S dispatch
- `createRemove.ts` — `remove(id)` — soft-delete; appends a `Deleted` audit entry and enqueues a C2S dispatch
- `createTableRequest.ts` — `tableRequest(request)` — imperative paginated fetch for table/grid component integrations

### Reactive hooks
- `createUseGet.ts` — `useGet(id)` — subscribes to a single record; re-renders on change
- `createUseGetAll.ts` — `useGetAll()` — subscribes to all records
- `createUseQuery.ts` — `useQuery(request)` — subscribes to a query result
- `createUseDistinct.ts` — `useDistinct(field, filters?)` — subscribes to distinct values
- **Failure semantics (`useQuery`, `useGetAll`, `useDistinct`):** a failure of the initial run or of any reactive re-run (collection change / subscription update) produces the same state: last data kept, `isLoading: false`, `error` set. The next successful run clears `error`, even if its result is identical to the one before the failure. `useGet` handles its own fetch failure the same way (its change listener only applies event payloads, so it has no re-run to fail).
- `createUseSubscription.ts` — `useSubscription(name, request)` — subscribes to a named server-side subscription

### Live requests (`query` / `getAll` / `distinct` with callbacks)
- Passing callbacks makes an imperative request *live*: it re-runs on every local collection change (debounced) and server subscription update. Pass them as a **`LiveRequestCallbacks` object** — `query(props, { onResponse, onSameResponse, onError })` (`live-request-models.ts`); a bare `onResponse` function as the second argument is also fine.
- **Deprecated** (kept for existing callers, marked `@deprecated`): the 3+-argument positional forms `query(props, onResponse, onSameResponse)`, `getAll(props, onResponse, onSameResponse)` and `distinct(field, onResponse, disable)`. They violate the max-2-parameters standard; new code must use the callbacks object. `toLiveRequestCallbacks.ts` normalises all forms.
- `distinct({ field, disable: true })` honours `disable` (previously the props-object form silently ignored it).

### Utilities
- `useSubscriptionWrapper.ts` — shared subscription lifecycle (subscribe, unsubscribe, re-subscribe on dependency change). Re-runs triggered by a collection change (debounced) or a subscription update are fire-and-forget, so the wrapper catches their failures. It passes each failure to the caller's optional `onError` callback (`LiveRequestCallbacks.onError`; the reactive hooks pass one through `query` / `getAll` / `distinct`), or logs it when the caller gives none. A failure also resets the last-result hash, so the next successful result is delivered even if it is unchanged. Failures of the initial run still reject the returned promise.

## Architecture

Imperative functions are plain async functions closed over a `DbCollection` instance from the `dbs` provider. They do not trigger re-renders.

Reactive hooks subscribe to the in-memory change-notification bus inside `DbCollection`. The bus fires whenever SQLite data changes — whether from a local write or an incoming S2C sync update. Each hook captures the relevant slice of data and updates its own state.

`createUpsert` / `createRemove` write to SQLite immediately, then the `ClientToServerSynchronisation` provider's timer picks up the change.

## Ambiguities and gotchas

- **`useSubscription` is server-side** — calls a named subscription defined via `extendCollection` on the server. Completely separate from the local reactive hooks.
- **`tableRequest` vs `useQuery`** — `tableRequest` is imperative (for library grid integrations); `useQuery` is the reactive equivalent.
- **`createFind.tests.ts`** — the only hook file with its own unit tests; covers filter-to-SQL edge cases.
- **`serverHints` on `query` / `useQuery` is server-only** — the optional `serverHints` field on a query request is *not* applied to the local SQLite query; it is passed through to the server's `onQuery` collection hook to interpret. It has no effect unless that hook reads it. See [../../../server/collections/AGENTS.md](../../../server/collections/AGENTS.md#server-query-hints-serverhints).

## Related

- [../../providers/dbs/AGENTS.md](../../providers/dbs/AGENTS.md) — `DbCollection` called by all ops
- [../../providers/AGENTS.md](../../providers/AGENTS.md) — C2S provider picks up upsert/remove
- [../../../common/auditor/AGENTS.md](../../../common/auditor/AGENTS.md) — audit entries written on upsert/remove
