# Server collections API (`src/server/collections/`)

`extendCollection` and the server-side `useCollection` accessor.

## Overview

`extendCollection` is the server's primary extension point: it attaches lifecycle hooks and optional seeding to a collection. `useCollection` provides a read/write accessor for use inside hooks and actions.

## Contents

- `extendCollection.ts` — `extendCollection(collection, hooks)` — registers hooks in a module-level registry; `ServerDbCollectionEvents` reads them when wiring change-stream callbacks
- `useCollection.ts` — `useCollection(collectionName)` — returns `{ collection, getAll, get, find, query, upsert, remove, distinct, onChange, removeOnChange }`; use inside `onAfter*` hooks for cross-collection cascades
- `index.ts` — re-exports both

## Available hooks

| Hook | When | Notes |
|------|------|-------|
| `onBeforeUpsert({ records })` | Before write, on originating instance | Use for validation |
| `onAfterUpsert({ records, insertedIds, updatedIds })` | After change stream, on all instances | Use for cascades |
| `onBeforeDelete({ recordIds })` | Before write, on originating instance | Use for validation |
| `onAfterDelete({ recordIds })` | After change stream, on all instances | Use for cascades |
| `onBeforeClear({ collectionName })` | Before clear, on originating instance | — |
| `onAfterClear({ collectionName })` | After clear, on originating instance only | Not change-stream driven |
| `onSeed(seedWith)` | At startup if `shouldSeedCollections: true` | — |
| `onQuery({ request, userId })` | Before query action/subscription fetch | Security scoping; interpret `serverHints` (see below) |

## Server query hints (`serverHints`)

`serverHints` is an optional, strongly-typed, **server-only** metadata bag on `QueryProps` / `QueryRequest` (defined in `common/models/collectionsModels.ts`). It is the channel by which a caller passes *intent* to a collection's `onQuery` hook — it is **never applied to the client's local SQLite query, and never forwarded into the server's MongoDB query**. It does nothing on its own; only an `onQuery` hook gives it meaning.

**Round trip:**
1. A caller sets `serverHints` on a query — `query(...)` / `useQuery(...)` on the client, or a server-side query.
2. The server entry points (`queryAction.ts`, `querySubscription.ts`) package it into the `request` passed to `onQuery({ request, userId })`.
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
- **`useCollection` inside hooks** — `onAfter*` hooks run outside socket request context. Use `useCollection` for cross-collection reads/writes; do not attempt to access user/socket context here.
- **`serverHints` is inert without an `onQuery` hook** — if no hook interprets them, the hints are silently ignored (they never reach the client SQLite query or the server Mongo query). A hint that "does nothing" usually means the `onQuery` hook isn't registered or isn't reading `request.serverHints`.

## Related

- [../AGENTS.md](../AGENTS.md) — parent server directory
- [../providers/db/AGENTS.md](../providers/db/AGENTS.md) — `ServerDbCollectionEvents` invokes hooks
- [../subscriptions/AGENTS.md](../subscriptions/AGENTS.md) — subscriptions also use `useCollection`
