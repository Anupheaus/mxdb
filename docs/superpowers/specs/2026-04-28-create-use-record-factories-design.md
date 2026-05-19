# Design: `createUseRecord` and `createUseRecords` Factory Hooks

**Date:** 2026-04-28  
**Status:** Approved

## Overview

Add four factory functions to mxdb that let consumers create strongly-typed, named hooks for individual records and record collections — both on the client (React) and on the server (async/imperative). Ported from the vision project's `createUseRecord` / `createUseRecords`, adapted for this library's internal structure, with `useAutoSave` inlined and shared types extracted to common.

---

## Common models (`src/common/models/hookModels.ts`)

Three types extracted here because they are used by both client and server implementations.

### `RecordTypeOfCollection<Collection>`
Moved from `src/client/useRecord.ts`. Extracts the record type from an `MXDBCollection`.

```ts
export type RecordTypeOfCollection<Collection extends MXDBCollection<Record>> =
  Collection extends MXDBCollection<infer RecordType> ? RecordType : never;
```

### `ExtensionsType`
Shared constraint for the `extensions` parameter on all four factories.

```ts
export type ExtensionsType = { [key: string]: (...args: any[]) => any };
```

### `RemoveDasherized<T extends string>`
Shared string utility type used by both `createUseRecords` factories to camelCase dasherized names (e.g. `"patient-visit"` → `patientVisit`).

```ts
export type RemoveDasherized<T extends string> =
  T extends `${infer Prefix}-${infer Suffix}`
    ? RemoveDasherized<`${Prefix}${Capitalize<Suffix>}`>
    : T;
```

All three are exported via `src/common/models/index.ts`. `src/client/useRecord.ts` updates its import of `RecordTypeOfCollection` to come from `../../common`.

---

## Client — `src/client/hooks/useRecord/`

### `createUseRecord.ts`

Factory that wraps the existing low-level `useRecord` hook with hydration, named API, auto-save, helpers, and extensions.

**Signature:**
```ts
createUseRecord(name, collection, { hydrateRecord, helpers?, extensions? })
```

**Returned hook overloads:**
```ts
useXxx(recordOrId: T | string | undefined): UseRecord<Name, T, HelperResults>
useXxx(recordOrId: T | string | undefined, createNew: true, ...args: Args): NonNullableUseRecord<Name, T, HelperResults>
```

**Result shape (`UseRecord`):**
| Field | Description |
|---|---|
| `xxx` | The (possibly hydrated) record |
| `setXxx` | Local state setter |
| `upsertXxx` | Persist to server |
| `removeXxx` | Delete the record |
| `isLoadingXxx` | True while fetching from db |
| `isNewXxx` | True if no persisted record exists yet |
| `autoSaveXxx(record)` | Debounced save (see below) |
| `...helpers` | Caller-defined derived values |

**Auto-save (inlined from `useAutoSave`):**
- Accepts `(record: T)` — debounces server upsert by 30 seconds (default)
- Updates local state immediately on every call
- Uses `is.deepEqual` to skip no-op calls
- Flushes immediately on component unmount (`useOnUnmount`)
- Flushes immediately on `window.beforeunload`

**`hydrateRecord(prevRecord, ...args)`:** Derives/default-fills the record before it is returned. Called whenever the loaded record or args change. If `recordOrId` is an id, it is stamped onto the hydrated record.

**`helpers(context)`:** Receives `{ recordOrId, ...baseResult }` and returns extra derived values. Function references in the result are stabilised via `useRef`/`useMemo` to avoid unnecessary re-renders.

**`extensions`:** Plain object whose entries are attached as static methods on the returned hook function.

**Exported types:** `UseRecord`, `NonNullableUseRecord`, `CreateUseRecordOptions`, `CreateUseRecord`

---

### `createUseRecords.ts`

Factory that wraps `useCollection` and returns two composable hooks.

**Signature:**
```ts
createUseRecords(name, collection, { additionalQueryProps?, helpers?, extensions? })
```

**`useXxx()` result shape (`UseRecords`):**
| Field | Description |
|---|---|
| `upsertXxx(records)` | Persist one or many records |
| `removeXxx(records\|ids)` | Delete one or many records |
| `queryXxx(props?)` | Imperative async query |
| `getXxx(id)` | Imperative async get |
| `...helpers` | Caller-defined derived values |

**`useXxx.query(...)` — reactive sub-hook:**

Three overloads:
```ts
useXxx.query(): UseRecordsQuery<Name, T>
useXxx.query(recordOrIds: Array<T | string>): UseRecordsQuery<Name, T>
useXxx.query(queryProps: QueryProps<T>): UseRecordsQuery<Name, T>
```

Result shape (`UseRecordsQuery`):
| Field | Description |
|---|---|
| `xxx` | Array of records (camelCased, dasherized names normalised) |
| `isLoadingXxx` | True while query is running |
| `totalXxx` | Total matching records (for pagination) |

When passed an array of ids, builds a `{ filters: { id: { $in: ids } }, disable: ids.length === 0 }` query, merged with `additionalQueryProps`.

**Exported types:** `UseRecords`, `UseRecordsQuery`

---

## Server — `src/server/hooks/useRecord/`

### `createUseRecord.ts`

Factory that wraps the server `useCollection` with hydration, named async API, helpers, and extensions.

**Signature:**
```ts
createUseRecord(name, collection, { hydrateRecord, helpers?, extensions? })
```

**Returned function:**
```ts
async useXxx(id: string | undefined, ...args: Args): Promise<ServerUseRecord<Name, T, HelperResults>>
```

**Result shape (`ServerUseRecord`):**
| Field | Description |
|---|---|
| `xxx` | The (possibly hydrated) record |
| `upsertXxx(record)` | Persist to MongoDB |
| `removeXxx()` | Delete the record |
| `isNewXxx` | True if no persisted record was found |
| `...helpers` | Caller-defined derived values |

No `setXxx` (no React state), no `isLoadingXxx` (awaited), no `autoSaveXxx` (server writes are explicit).

`hydrateRecord` is synchronous. `helpers` is called synchronously on the base result.

**Exported types:** `ServerUseRecord`, `CreateUseRecordOptions`, `CreateUseRecord`

---

## Server — `src/server/hooks/useRecords/`

### `createUseRecords.ts`

Factory that wraps server `useCollection` with named methods and an async query helper.

**Signature:**
```ts
createUseRecords(name, collection, { additionalQueryProps?, helpers?, extensions? })
```

**`useXxx()` result shape (`ServerUseRecords`):**
| Field | Description |
|---|---|
| `queryXxx(props?)` | Async query → `QueryResults<T>` |
| `getAllXxx()` | Async fetch all records |
| `upsertXxx(records)` | Persist one or many |
| `removeXxx(records\|ids)` | Delete one or many |
| `getXxx(id)` | Async get by id |
| `findXxx(filters)` | Async find first match |
| `distinctXxx(field, props?)` | Async distinct values |
| `...helpers` | Caller-defined derived values |

**`useXxx.query(...)` — async query helper:**

Three overloads:
```ts
useXxx.query(): Promise<ServerUseRecordsQuery<Name, T>>
useXxx.query(recordOrIds: Array<T | string>): Promise<ServerUseRecordsQuery<Name, T>>
useXxx.query(queryProps: QueryProps<T>): Promise<ServerUseRecordsQuery<Name, T>>
```

Result shape (`ServerUseRecordsQuery`):
| Field | Description |
|---|---|
| `xxx` | Array of records |
| `totalXxx` | Total matching records |

No `isLoadingXxx` — the promise resolves before destructuring.

**Exported types:** `ServerUseRecords`, `ServerUseRecordsQuery`

---

## File layout

```
src/common/models/
  hookModels.ts         ← new: RecordTypeOfCollection, ExtensionsType, RemoveDasherized
  index.ts              ← add export for hookModels

src/client/hooks/
  useRecord/
    createUseRecord.ts  ← new
    index.ts            ← new
  useRecords/
    createUseRecords.ts ← new
    index.ts            ← new
  index.ts              ← add exports for useRecord and useRecords folders

src/client/useRecord.ts ← update import of RecordTypeOfCollection to come from ../../common

src/server/hooks/
  useRecord/
    createUseRecord.ts  ← new
    index.ts            ← new
  useRecords/
    createUseRecords.ts ← new
    index.ts            ← new
  index.ts              ← add exports for useRecord and useRecords folders
```

---

## Dependencies

| Dependency | Used by |
|---|---|
| `@anupheaus/common` — `is`, `Record`, `AnyObject` | all four factories |
| `@anupheaus/react-ui` — `useBound`, `useUpdatableState`, `useDebounce`, `useOnUnmount` | client factories only |
| `useRecord` (existing low-level hook) | client `createUseRecord` |
| `useCollection` (client) | client `createUseRecords` |
| `useCollection` (server) | server `createUseRecord`, server `createUseRecords` |
| `QueryProps`, `MXDBCollection` | all four factories (from `src/common`) |
| `RecordTypeOfCollection`, `ExtensionsType`, `RemoveDasherized` | all four factories (from `src/common/models`) |
