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
- `createUseSubscription.ts` — `useSubscription(name, request)` — subscribes to a named server-side subscription

### Utilities
- `useSubscriptionWrapper.ts` — shared subscription lifecycle (subscribe, unsubscribe, re-subscribe on dependency change)

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
