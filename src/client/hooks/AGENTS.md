# Client hooks (`src/client/hooks/`)

All React hooks exposed by the client layer — both raw collection primitives and the named-API factory hooks built on top of them.

## Overview

This directory contains two layers:

1. **Primitive hooks** — low-level access to the local SQLite store and socket context (`useCollection`, `useAuth`, `useMXDBUserId`, `useMXDBSignOut`).
2. **Factory hooks** — higher-level builders (`createUseRecord`, `createUseRecords`) that wrap the primitives with strongly-typed, named APIs and optional hydration, auto-save, helpers, and extensions. Factories are called once at module level; the returned hook is used inside components.

## Contents

### Factory hooks

#### `useRecord/` — single-record form-edit factory
- `createUseRecord(name, collection, options)` — creates a named hook for a single record. The returned hook `useXxx(recordOrId)` provides: the record (`xxx`), `setXxx`, `upsertXxx`, `removeXxx`, `isLoadingXxx`, `isNewXxx`, and `autoSaveXxx`.
  - `options.hydrateRecord(prev, ...args)` — derives/hydrates the record from the loaded value. Called on every update; must be pure. Receives `undefined` for `prev` when no record exists yet.
  - `options.helpers(ctx)` — derives additional computed values; `ctx` is the full base result **plus** `recordOrId`, so helpers can branch on whether a record/id was passed. Stabilised via `useStableHelpers`.
  - `options.extensions` — static methods attached directly to the hook function (not the return value).
  - `createNew: true` overload — `useXxx(recordOrId, true, ...args)` guarantees a non-null record even when no persisted record exists. The extra `...args` are forwarded to `hydrateRecord` on every update.
- `UseRecord<Name, T, Helpers>` / `NonNullableUseRecord<...>` — result types for the standard and `createNew: true` overloads.
- `CreateUseRecordOptions<...>` / `CreateUseRecord<...>` — options type and utility type for the return value of `createUseRecord`.

#### `useRecords/` — multi-record collection factory
- `createUseRecords(name, collection, options?)` — creates a named hook for a collection. `useXxx()` (sync) returns `{ upsertXxx, removeXxx, queryXxx, getXxx }`. `useXxx.query(...)` (reactive sub-hook) returns `{ xxx[], isLoadingXxx, totalXxx }`. `queryXxx(props?)` is an async one-time call returning `{ xxx[], totalXxx }` (same named shape, no `isLoading`).
  - Three `query` overloads: no-args, ids array (`Array<T | string>`), or `QueryProps<T>`.
  - `options.additionalQueryProps` — default query props merged into all query overloads; caller-supplied props win.
  - `options.helpers()` — derives additional values merged into the `useXxx()` result; stabilised via `useStableHelpers`.
  - `options.extensions` — static methods on the hook function.
- `UseRecords<Name, T, Helpers>` / `UseRecordsQuery<Name, T>` — result types.

### Collection primitive (`useCollection/`)
`useCollection(collection)` — the primary raw API: imperative CRUD + reactive `useQuery`, `useGet`, `useGetAll`, `useDistinct`, `useSubscription`. The factories above build on this. See [useCollection/AGENTS.md](useCollection/AGENTS.md).

### Auth / identity hooks
- `useAuth.ts` — `useAuth()` — auth state for the current device (signed in, device id)
- `useMXDBSignOut.ts` — `useMXDBSignOut()` — triggers sign-out on the current device
- `useMXDBUserId.ts` — `useMXDBUserId()` — current user's id from socket context

### Internal utilities
- `useStableHelpers.ts` — `useStableHelpers(rawHelpers)` — wraps helper function values in stable refs so component identity doesn't change on every render. Not exported publicly; used internally by `createUseRecord` and `createUseRecords`.

## Architecture

**Factory pattern:** `createUseRecord` / `createUseRecords` are called once at module level (outside any component). They return a hook (or hook-with-static-methods) that can be called inside components. This means the factory closure captures `name`, `collection`, and `options` permanently — changing these after the fact has no effect.

**`RemoveDasherized` key mapping:** Dasherized collection names like `'order-item'` are converted to camelCase at both the type level (`RemoveDasherized<Name>`) and at runtime (`name.toVariableName()`). The result key is `orderItem`, the upsert key is `upsertOrderItem`, etc.

**Auto-save in `createUseRecord`:** `autoSaveXxx(record)` debounces upserts (30 s). The debounce is flushed on component unmount (`useOnUnmount`) and on `window.beforeunload`. The flush clears the pending record before awaiting, preventing a double-save if the user cancels navigation. If the save fails, the flush never rejects (all callers are fire-and-forget): the error is logged and the record is put back as pending — unless a newer edit was queued meanwhile — so the next flush (next edit, unmount or `beforeunload`) retries it rather than dropping the edit.

**`useXxx.query()` vs `useXxx().queryXxx`:** The reactive `.query()` sub-hook calls `useCollection().useQuery()` internally — it subscribes to live updates and re-renders when results change. The `queryXxx` method on the `useXxx()` result is a one-time async call (wraps `useCollection().query()`) — not reactive. Both return the same named shape `{ xxx[], totalXxx }` (`.query()` adds `isLoadingXxx`; `queryXxx` does not).

## Ambiguities and gotchas

- **Factory vs hook:** `createUseRecord` / `createUseRecords` are factory functions — call them at module scope, not inside components. Calling them inside a component on every render creates a new hook identity.
- **`additionalQueryProps` vs caller props:** `additionalQueryProps` is merged as a default; caller-supplied `QueryProps` always wins. For the ids-array overload, the computed `$in` filter always wins even if `additionalQueryProps.filters` is set.
- **`autoSaveXxx` vs `upsertXxx`:** `autoSaveXxx` debounces and updates local React state immediately; `upsertXxx` persists to the server synchronously. For form inputs, use `autoSaveXxx`. For explicit submit actions, use `upsertXxx`.
- **`helpers` receives the current base result** — including the record after hydration, so computed helpers can derive values from `xxx`, `isNewXxx`, etc. Helper functions are stabilised so they don't cause re-renders when recreated.

## Related

- [useCollection/AGENTS.md](useCollection/AGENTS.md) — raw collection primitive used internally by `createUseRecords`
- [../useRecord.ts](../useRecord.ts) — low-level single-record hook used internally by `createUseRecord`
- [../../common/models/hookModels.ts](../../common/models/hookModels.ts) — shared types: `RecordTypeOfCollection`, `ExtensionsType`, `RemoveDasherized`
- [../../server/hooks/AGENTS.md](../../server/hooks/AGENTS.md) — server-side equivalents (`createUseRecord` / `createUseRecords` as plain async factories)
