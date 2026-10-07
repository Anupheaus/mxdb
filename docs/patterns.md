# MXDB — Patterns

Recurring "how we do X" recipes for building on **MXDB** (`@anupheaus/mxdb`, with real-time sync via `@anupheaus/mxdb-sync`). MXDB is a MongoDB-backed **reactive data layer** with real-time client↔server sync over Socket.IO: collections are shared schema, clients hold live replicas, and reactive hooks re-render as records change.

This document captures the *shapes* that repeat when consuming MXDB — collections, client/server data hooks, record models, testing, and edit reconciliation — so new work stays consistent. Patterns that are purely application-level (routing, auth actions, third-party integrations, env wiring) live in the consuming app's own patterns doc, not here.

---

## 1. Real-Time Collections as the Primary Data Layer

The default data mechanism is a **collection**: a MongoDB-backed schema, shared client↔server, that syncs live to connected clients.

```ts
export const entityCollection = defineCollection<Entity>({
  name: 'entities',
  indexes: [],
  version: 1,
  onSeed: async useCollection => {
    const { seedWith } = useCollection(entityCollection);
    await seedWith({ fixedRecords: entityData });
  },
});
```

Conventions:
- **One folder per domain entity**: `<entity>Collection.ts`, optional `<entity>-seed-data.ts`, and `index.ts`.
- The collection type parameter extends `Record` (`{ id, … }`) — see §4.
- **Seed data** is inserted on first run through `onSeed` (categories, types, system settings, fixed lookups).
- **`version`** is bumped when the on-disk shape changes so migrations run.
- Collections are registered into **sync sets** by client capability — a full replica for full-featured clients, a leaner subset for constrained (e.g. mobile/Capacitor) clients. **Don't sync data that is large, expensive to aggregate, or doesn't need live reactivity** — keep those out of the sync sets and fetch on demand.
- **Server-only wiring lives separately** from the shared schema (a server-side extension per entity) and adds server indexes, server-only hooks (`onAfterUpsert`), and server-only collections (e.g. token stores). The shared `defineCollection` stays free of server-only concerns. A `syncMode: 'ServerOnly'` collection needs no read or write guard of its own: mxdb refuses every client request that names one, so only server code (actions, hooks, jobs) can touch it.

---

## 2. Client Data Hooks

Reactive data access is factory-generated from a collection. Two families, plus a raw escape hatch.

### 2a. List hooks — `createUseRecords`
```ts
export const useSurveyRoomTypes = createUseRecords('survey-room-types', surveyRoomTypesCollection);
```
Returns `surveyRoomTypes`, `isLoadingSurveyRoomTypes`, `upsertSurveyRoomTypes`, `removeSurveyRoomTypes`, `totalSurveyRoomTypes`, `querySurveyRoomTypes`, `getSurveyRoomTypes` — names derived from the record label. Accepts `extensions` (§2d).

### 2b. Single-record hooks — `createUseRecord`
```ts
export const useSurvey = createUseRecord('survey', surveysCollection, {
  hydrateRecord: (survey, addressId) => ({ id: Math.uniqueId(), addressId, rooms: [], ...survey }),
  extensions: { byAppointment: surveyByAppointmentHelper },
});
```
Returns `survey`, `isLoadingSurvey`, `isNewSurvey`, `setSurvey`, `upsertSurvey`, `removeSurvey`.
- **`hydrateRecord`** provides a default new record when none exists yet.

### Live results are compared by value, never hashed
A live request (`query` / `getAll` / `distinct` with callbacks) re-runs after every burst of collection changes and
delivers the result only if it changed. The last delivered result is kept and compared with `is.deepEqual` (DateTimes by
instant, in arrays too; two invalid DateTimes alike are equal); `onSameResponse` fires otherwise. Never hash a result to
compare it: `Object.hash` (object-hash) walks every record and each DateTime's prototype chain, and on a screen of live
lists it was most of the CPU the page spent (Vision's Pipeline, 29 Sep 2026: about 60% of opening it and a lead).
`useQuery` / `useGetAll` keep their props the same way (`useDeepEqualValue`), never hashing them per render.

- **A change of zone alone is not a change.** A DateTime moved to another zone at the same instant compares equal, so the
  result is not delivered again. Anything that must show a new zone reads it from somewhere else (a setting, the user's
  locale) — never from a record's DateTime having been re-zoned.

### An empty or broken condition fails closed, never "no condition"
`{ filters: { leadId: undefined } }` matches the records with **no** `leadId`, on the device (SQLite and the in-memory
path), in live lists, and on the server — the same as `{ leadId: null }`. An operator whose operand is missing, `null`
or of the wrong type matches **nothing**: `{ id: { $in: contact?.addressIds } }` with no contact, `$gte: undefined`,
`$eq: null`, `$exists: 'yes'`, `$all: []`, and a `$or` / `$and` / `$nor` without a non-empty list of filters. These
used to be dropped, so a screen whose key was missing read every record in the collection, and the server could not
tell it from a deliberate read of everything (Vision sc-2518). One function decides all of it for client and server
(`src/common/filters/normaliseFilterConditions.ts`); `filterOperandCases.fixture.ts` pins every operator on both.

- A filter with no conditions at all (`undefined` or `{}`) still reads everything.
- Want "any value"? Leave the key out of the filter. Want "unbounded"? Leave the bound out. Want "missing"? Write
  `{ field: null }` (or leave it undefined); `{ $eq: null }` matches nothing.
- Keep disabling a read whose key is missing (`disable: !hasKey`) where loading nothing is the point: it saves the
  round trip and says what you mean.

### Delivered records are read-only
Records a live request delivers are the collection's own objects, and a record passed to `upsert` becomes one. Treat
both as immutable: to change a record, copy it (`{ ...record, name }`) and upsert the copy. Two things rely on it — the
collection's `upsert` returns early when the record is deep-equal to the stored one, and a live request compares each
re-run with the last result it delivered — so a record changed in place would never be saved, or never be delivered.
In a development build (`NODE_ENV` `development`) delivered arrays and records are frozen (`freezeInDevelopment`), so
such a change throws where it is made; DateTimes and other class instances inside are left alone. The same goes for a
hook's props: `useQuery` / `useGetAll` compare them by value against the last props they saw (`useDeepEqualValue`), so a
props object changed in place is never noticed — pass a new one.

### 2c. Raw hooks for bespoke logic
When a hook needs custom querying/side-effects, use `useCollection` / `useRecord` from `@anupheaus/mxdb/client` directly, composing them with other hooks as needed.

### 2d. Extensions — named query variants on the hook function
Both factories accept an **`extensions`** option: named sub-hooks attached as **static methods on the hook function** itself (`useSurvey.byAppointment(...)`, `useAppointments.for(...)`). They're the idiomatic home for query variants and derived reads that need custom logic beyond the default API.

```ts
export const useAppointments = createUseRecords('appointments', appointmentsCollection, {
  extensions: {
    for: ({ date, userId, types }: GetAppointmentsForProps) => {
      const { useQuery } = useCollection(appointmentsCollection);
      return useQuery(/* … */);
    },
  },
});
```

- Each extension is a **hook in its own right** — it may call `useCollection`, compose other hooks, and must obey the rules of hooks (called from a component/hook, not conditionally).
- Keep non-trivial extensions in **their own file** and reference them (e.g. `byAppointment: surveyByAppointmentHelper`) rather than inlining large bodies.
- Prefer an extension over a bespoke `useCollection` hook whenever the variant belongs to an existing entity — it keeps every read for that entity discoverable off the one `use[Entity]` surface.

Conventions across all families:
- File and export are `use[Entity]` / `use[Entity]s`; one hook per file; folder barrelled by `index.ts` (§6).
- Use `String.undefined()` (not `''`) for not-yet-known IDs to distinguish "unset" from "intentionally blank".
- **Prefer these reactive hooks** for any data that lives in a synced collection, rather than bespoke fetching.

---

## 3. Server Data Hooks

The server mirror of §2: `createUseRecords` from `@anupheaus/mxdb/server`, wrapping one collection and exposing **named domain helpers** so server code never touches collections directly.

```ts
export const useOrders = createUseRecords('orders', ordersCollection, {
  helpers: context => ({
    convertQuoteToOrder: (quoteId, payment, options) => convertQuoteToOrder(context, quoteId, payment, options),
    lockQuote, isLockedQuote, isQuote, refreshQuote, enrichQuote,
  }),
});
```

- **`helpers`** derive additional values that are **merged into the hook's result** (`useOrders().convertQuoteToOrder(...)`); they receive the hook context so they can reach the collection API.
- **`extensions`** (as in §2d) are **static methods on the hook function** (`useUsers.getUserAndContact(...)`) — use these for standalone operations that don't need to be part of a live result.
- Each helper/extension is implemented in **its own file** in the same folder (`lockQuote.ts`, `refreshQuote.ts`, …) and composed in via `helpers: context => ({ … })` / `extensions: { … }`.
- Import from the barrel: `import { useOrders } from '../../../common/hooks'`.
- **Pure helpers (no `useCollection`) are kept separate from impure ones** so they unit-test in isolation (§5).
- All server-side data access goes **through these hooks**, never `useCollection` directly, so domain rules live in one place.

### 3a. Before-write hooks — derive, validate, reject

`onBeforeUpsert` / `onBeforeDelete` (registered with `extendCollection` in the entity's server extension) run on the server **before anything is persisted**, for server-side writes and synced client writes alike, and only for real changes (unchanged or re-sent records, and deletes of records that are not stored, don't fire them).

```ts
extendCollection(addressesCollection, {
  // Derive: amend the records in place — the amendment is audited and synced back to the writing client.
  async onBeforeUpsert({ records }) { await clearStaleCoordinates(records); },
  // Validate: throw to reject. Use a message you'd show the user.
  async onBeforeDelete({ recordIds }) { await assertNotReferenced(recordIds); },
});
```

- **Prefer amending to throwing** for client-writable data: an amendment keeps the user's change; a rejection discards it.
- **Throwing on a server write** rejects the whole call (all-or-nothing, like any failed write).
- **Throwing on a synced client write rejects only that record** (hooks are called per record on the sync path) and reverts it on the device: an update goes back to the server's version, a create is dropped, a delete stays deleted locally while the server keeps the record. The app hears about it through `MXDBSync`'s `onSyncRejected(rejections)` (`{ collectionName, recordId, reason, kind }`, `reason` = the thrown message). **Throw a `ValidationError` (from `@anupheaus/common`) with a message you'd show the user**: it arrives with `kind: 'validation'`, and only then is `reason` meant for the screen — show the user why. Anything else a hook throws arrives as `kind: 'error'` (technical detail: log it, show a generic message), a read-gate refusal as `kind: 'access'`; `kind` is absent from servers older than 0.2.5. On a server write the call fails with the hook's own error, so an action can make the same distinction.
- **When a hook amends instead of refusing, say so.** Refusing would throw away the user's other edits, so a guard may put its protected fields back and let the rest save, but the user then sees a field snap back with no explanation. Return `[{ id, note }]` from `onBeforeUpsert` (a plain-English `note`, only for a record you really changed); on a synced write the app hears it through `MXDBSync`'s `onSyncAmended(amendments)` (`{ collectionName, recordId, note }`, one call per sync response) while the amended record is pushed back as usual. Show it as a warning, not an error: the save succeeded. Absent from servers older than 0.2.8.
- Hooks run in the writer's context, so `useCollection` inside them hits the same database; never upsert the same collection from its own `onBeforeUpsert`.
- **A rule that reads other records needs a `writeLock`.** Without one, mxdb checks and then saves, and another write can land in between and make the rule untrue after it passed. `extendCollection(collection, { writeLock })` holds the lock across the check and the save on every write path (server upsert, remove, clear and a synced batch). Give the same re-entrant lock to the actions that change what the rule reads. Details: `src/server/collections/AGENTS.md`, "The write lock".
- **Other sync failures are not rejections.** A change the server keeps failing to write for any other reason stays on the device and is retried with backoff; after a few attempts `MXDBSync`'s `onError` receives a `SYNC_STALLED` error (worth a non-blocking "changes not saved yet" indicator). It syncs as soon as the server accepts it.

### 3b. The read gate — `onQuery`, for reads and for writes

`onQuery` is the collection's read gate: every client read (`query`, `get`, `getAll`, `distinct`, change pushes, reconnect sync) is narrowed by the filters it returns. It is also the write gate: a synced client change to a stored record outside its filters is refused (`kind: 'access'`). The payload's `purpose` says which is being asked — `'read'` (also when absent) or `'write'`.

- **Authority applies to both.** Ownership and role rules ("a fitter sees only their own tasks") ignore `purpose`.
- **Delivery scope applies to reads only.** A rule that limits what a client *holds* rather than what the user may change (a device's date window) returns no filter for `'write'`. Otherwise an edit made offline to a record that has since left the scope is refused and lost. With the scope left out, the edit is saved, and the record, no longer readable, is then evicted from the device.

---

## 4. Records: Interface + Namespace

Every record stored in a collection is a `Record`-extending interface paired with a same-named namespace holding its factory + logic.

```ts
export interface SurveyRoom extends Record {
  typeIds: string[];
  windows: SurveyWindow[];
}
export namespace SurveyRoom {
  export const create = (): SurveyRoom => ({ id: Math.uniqueId(), typeIds: [], windows: [] });
  export function generateLabel(roomTypes: SurveyRoomType[], typeIds: string[]): string | undefined { /* … */ }
}
```

- `Record` (`{ id, … }`) comes from `@anupheaus/common`; `create()` mints `id` via `Math.uniqueId()`.
- Sub-type enumerations are exposed as namespace members (e.g. `Appointment.Type.types`).
- Organised by domain folder, each barrelled by `index.ts`.
- Import the **type** with `import type { Entity } from '…/models'` and the **namespace** with `import { Entity } from '…/models'`.

---

## 5. Pure-Logic Extraction + Colocated Tests

Business logic that can be pure is pulled into its own file with a colocated `*.tests.ts` (ts-mocha + chai).

- **Pure functions import only `@anupheaus/common` (+ small utils like luxon)** so their tests avoid the **ESM-only `@anupheaus/mxdb/server` chain** — importing the server data layer into a test forces the whole ESM toolchain and slows/breaks the unit test. Keep the testable core free of `useCollection`.
- Rule of thumb: **orchestrator (impure, touches collections/I-O) + pure helpers (tested)** — never mix data access into the testable core.

---

## 6. Barrel `index.ts` Everywhere

Every folder — collections, hooks, models — has an `index.ts` doing `export * from './file-name'`. Cross-module imports target the barrel (e.g. `…/models`, `…/hooks`), not deep files. This keeps the mxdb-facing surface (collections, hooks) stable as internal files move.

---

## 7. Editing Reconciliation (auto-save against a live collection)

Because a collection syncs live, a form editing one of its records must guard against **incoming server updates clobbering unsaved local edits**. Reconcile with `useUpdatableState` + an `isDirtyRef` and flush via an auto-save:

```ts
const [survey, setSurvey] = useUpdatableState<Survey | undefined>(prev => {
  const server = surveys.first();
  if (server && isDirtyRef.current && prev?.id === server.id) return prev; // keep local edits
  return server ?? Survey.create({ addressId: appointment!.addressId });
}, [surveys, appointment]);

const autoSaveSurvey = useAutoSave<Survey>(
  updated => { isDirtyRef.current = true; setSurvey(updated); },
  async updated => { await upsertSurvey(updated); isDirtyRef.current = false; },
);
```

- On a live update: if the local copy is dirty and refers to the same record, **keep the local edit**; otherwise take the server value.
- Clear `isDirtyRef` only **after** the `upsert` resolves, so a mid-save sync can't drop the pending write.

---

## 8. Folder Grammar (quick reference)

| Concern | Location | Factory / primitive |
|---|---|---|
| Collection schema | `<entity>/*Collection.ts` | `defineCollection<T>()` |
| Server collection wiring | server `extensions/<entity>/` | extension + `onAfterUpsert` hooks |
| Client list hook | client `hooks/<entity>/use*.ts` | `createUseRecords(name, collection, { extensions })` |
| Client record hook | client `hooks/<entity>/use*.ts` | `createUseRecord(name, collection, { hydrateRecord, extensions })` |
| Server data hook | server `hooks/<entity>/use*.ts` | `createUseRecords(name, collection, { helpers, extensions })` |
| Record model | `models/<domain>/*-models.ts` | `interface extends Record` + `namespace` |

**Living docs:** each folder carries an `agents.md` describing its current structure and conventions; keeping it accurate is part of completing a change.
