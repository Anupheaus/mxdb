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
- **Server-only wiring lives separately** from the shared schema (a server-side extension per entity) and adds server indexes, server-only hooks (`onAfterUpsert`), and server-only collections (e.g. token stores). The shared `defineCollection` stays free of server-only concerns.

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
- **Throwing on a synced client write rejects only that record** (hooks are called per record on the sync path) and reverts it on the device: an update goes back to the server's version, a create is dropped, a delete stays deleted locally while the server keeps the record. The app hears about it through `MXDBSync`'s `onSyncRejected(rejections)` (`{ collectionName, recordId, reason }`, `reason` = the thrown message) — show the user why.
- Hooks run in the writer's context, so `useCollection` inside them hits the same database; never upsert the same collection from its own `onBeforeUpsert`.

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
