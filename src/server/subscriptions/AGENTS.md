# Server subscriptions (`src/server/subscriptions/`)

Persistent server-side subscriptions: push live data to clients as the underlying data changes.

## Overview

Subscriptions differ from actions in that they remain active after the initial response: the server pushes updates whenever the collection changes. Each subscription is registered via `createServerCollectionSubscription` and backed by an `onChange` listener on `ServerDbCollection`.

## Contents

- `getAllSubscription.ts` — `serverGetAllSubscription` — pushes a full snapshot initially, then diffs on each change and pushes added/removed ids
- `querySubscription.ts` — `serverQuerySubscription` — paginated/filtered subscription; pushes matching records on every change and sends the client a new total only when the total or the ordered record ids differ from what the client last received (the initial response, then each update sent). Forwards the request's `serverHints` to the collection's `onQuery` hook (see [../collections/AGENTS.md](../collections/AGENTS.md#server-query-hints-serverhints)), then drops them before the actual fetch
- `distinctSubscription.ts` — `serverDistinctSubscription` — distinct field values; pushes records on every change and sends the client a new hash of the ordered ids only when it differs from what the client last received
- `createServerCollectionSubscription.ts` — factory that creates type-safe collection subscription handlers; remembers the previous response / additional data per subscription id (cleared on unsubscribe) and wraps `update` so it never rejects (see gotchas)
- `pushSubscriptionResultRecords.ts` — routes records to the client via the S2C dispatch path (updates the `ServerDispatcher` filter with `addToFilter=true`)
- `internalSubscriptions.ts` — re-exports internal subscription descriptors from `src/common/internalSubscriptions.ts`

## Architecture

Each subscription:
1. Executes an initial fetch and pushes records via `pushSubscriptionResultRecords`.
2. Registers an `onChange` listener that re-fetches and pushes diffs whenever the collection changes.
3. Cleans up the `onChange` listener on `onUnsubscribe`.

`pushSubscriptionResultRecords` routes all records through `ServerDispatcher.push` (with `addToFilter=true`) so the SD filter stays in sync with what the client holds. This matters for subsequent change-stream events — the SD must know a client holds a record before it can send change-stream updates for it.

## Ambiguities and gotchas

- **Subscription data reaches the client as S2C cursor pushes, not action responses.** This is intentional — routing through the SD keeps the SD filter accurate. The client-side `useSubscription` hook uses the `ClientReceiver` path, not a direct response handler.
- **The handler's `update` never rejects.** It returns a promise that resolves once the push has been sent (await it to sequence), but a failed push is caught inside the wrapper: a socket disconnect (`isSocketDisconnectError` in `../utils/`, shared with `useCollection`'s `onChange` guard) is logged at `debug`, anything else at `error` with the subscription id. Fire-and-forget calls are therefore safe.
- **`previousResponse` / `additionalData` are what an *earlier* subscribe with the same id left behind** — not what this subscribe's client holds, since the client is sent this subscribe's fresh initial response. Change-diffing baselines must start from the initial response computed at subscribe time and advance with every update sent; comparing against the handler-parameter snapshot goes stale after the first update. `serverQuerySubscription` and `serverDistinctSubscription` keep that baseline in a closure; `serverGetAllSubscription` re-reads it from the data store, which it rewrites on every snapshot (initial and change).
- **`serverGetAllSubscription` stores prior record ids** via `updateAdditionalData` to compute the `removedIds` diff on each change. If this data is lost (e.g. server restart mid-subscription), the next push sends a full snapshot, which is safe.

## Related

- [../AGENTS.md](../AGENTS.md) — parent server directory
- [../collections/AGENTS.md](../collections/AGENTS.md) — `useCollection` used to fetch data
- [../../common/sync-engine/AGENTS.md](../../common/sync-engine/AGENTS.md) — SD push path
