# Virtual collections & public (JWT-scoped) access

This document specifies **virtual collections** — server-only, read-only collections whose records are **projected** from one or more source collections — and the **public access mode** that lets unauthenticated visitors read a scoped subset of them without a local database or client session.

It builds on [design.md](./design.md) (storage, sync lifecycle, per-user encrypted DB) and the S2C/C2S specs. Where this document and `design.md` differ, **treat this document as the target contract for these two features**.

> **Status:** Design note / target spec. No implementation yet. This captures the model agreed during design so it can be reviewed before code.

---

## 1. Goals & motivation

1. **Expose safe fields, hide PII.** A public page must be able to render data derived from a PII-bearing source collection (e.g. `users`) **without the PII ever reaching that audience**. Projection therefore happens **server-side only**; only the safe, projected record crosses the wire.
2. **Row-level scope per viewer.** Different viewers see **different subsets** of the same virtual collection. Scope is an authorization concern resolved **server-side** from the caller's identity (authenticated user) or a **JWT capability** (public visitor).
3. **Agnostic consumer components.** The same hooks (`useCollection`, `useQuery`, …) work unchanged whether the current user is **private** (authenticated, synced, local DB) or **public** (unauthenticated, ephemeral, no DB). Components never branch on mode.
4. **Read-only.** Virtual collections are not writable through the collection API. Mutations, where required, go through explicit server actions (§7).

### 1.1 Why this is new for MXDB

Until now the library has had **no row-level authorization**: every user owns a **private, per-user encrypted database** ([design.md §4.8](./design.md) — *"each user's database is independent… no shared collections or cross-user record references"*). Principals never shared a collection, so there was nothing to scope. Virtual collections with per-viewer scope are the **first** feature that requires the server to return *a subset of a shared collection* to a principal. That authorization boundary — not the projection — is the substantive new capability.

---

## 2. Virtual collection definition

A virtual collection has **two halves** with different visibility:

- **Shared declaration** — imported by both client and server: the collection `name`, the **output (safe) shape**, and the **id derivation** (§3). This is all the client is allowed to know.
- **Server-only definition** — lives exclusively in server code: the **source collections**, the **compose/projection function**, the **scope resolver**, and the **invalidation mapping** (§5). The projection function is **security-critical** and MUST never be bundled to the client.

```ts
// Shared (client + server) — safe to ship to any audience
export interface VirtualCollectionDeclaration<Out extends Record> {
  name: string;
  /** Parts of the composite key, in order, used to derive the record id (§3). */
  keyOf: (out: Out) => string[];
}

// Server-only — never bundled to the client
export interface VirtualCollectionServerDefinition<Out extends Record> {
  sources: MXDBCollection[];
  /** Projects source rows into the safe output shape. Security boundary. */
  compose(ctx: ComposeContext): Out | Out[] | undefined;
  /** Derives the mandatory row-level filter for a principal (§6). */
  scope(principal: Principal): DataFilters<Out>;
  /** Maps a source-record change to the affected virtual id(s) (§5.2). */
  affects(source: MXDBCollection, changedRecord: Record): string[];
}
```

### 2.1 Never audited

Virtual collections MUST NOT carry an audit trail. Two reasons:

1. **Derived data is not a source of truth** — auditing it would create a second authoritative copy of fields that already live (and are audited) in the source collections, reintroducing exactly the conflict-resolution problem the audit system exists to prevent.
2. **PII leaks through history.** The source collection's audit entries (`Created`/`Updated`) contain the PII ([design.md §2.2](./design.md)). Syncing any of that history to a public audience would defeat the projection. Only the **materialised, projected live record** ever travels — using the audit-free push path ([design.md §5.6](./design.md)).

A virtual collection therefore behaves like a `disableAudit`, server-authoritative, **push-only-down** collection: the client never writes it and never sees its (non-existent) history.

---

## 3. Composite keys

Source rows may need **more than one id** to be unique in the projection (e.g. a user × organisation membership). MXDB's storage assumes a **single `id TEXT PRIMARY KEY`** everywhere (SQLite, Mongo `_id`, audit `recordId`, the per-client id sets in [design.md §5.6](./design.md)). Rather than change that:

- **Collapse the composite key into a deterministic string `id`** — e.g. `` `${userId}:${orgId}` `` — computed by `keyOf`.
- **Expose the parts as ordinary fields** (`userId`, `orgId`) on the output record for querying/filtering.

"More than one id to make unique" becomes a **formatting rule**, not a schema change; all existing single-id machinery keeps working.

---

## 4. Access modes

The two modes differ only in **where writes durably land** and **whether background sync exists**. Both read through a **reactive read-model that writes flow through** (§8) — that shared shape is what makes components agnostic.

| | **Private** | **Public** |
|---|---|---|
| Identity | Authenticated MXDB user | JWT capability in the entry URL |
| Local storage | Encrypted per-user SQLite DB | **None** |
| Client session | Created & persisted | **Not created, not stored** |
| Reactive read-model | Local DB + `onChange` | In-memory normalised store (§8) |
| Sync | Full sync lifecycle (design.md §5) | **None** — one-shot fetch per navigation |
| Subscriptions | Live (initial fetch + listener) | **Initial fetch only** — degrades to an action (§9) |
| Scope source | Authenticated user | JWT scope claim |
| Lifetime | Across sessions | Per page load; refresh re-requests |

### 4.1 Public visitor bootstrap

1. The visitor is directed to a page with a **JWT in the URL**.
2. The client **extracts the JWT into memory**, then **`history.replaceState()`** to remove it from the address bar (§10).
3. The JWT is used as the **bearer** on public actions/subscription calls.
4. No local database is opened; no session is persisted. On refresh, the flow repeats (or the app re-supplies the token) and data is re-requested from the server.

The consumer's components and hooks are identical to private mode; a **mode-aware transport provider** (e.g. `MXDBPublic` vs `MXDBSync`) selects the backing behaviour once at bootstrap.

---

## 5. Server-side materialisation & invalidation

### 5.1 Materialisation

The server maintains the virtual collection as materialised, projected rows (audit-free, §2.1). `compose` runs server-side against the source collections; only the output shape is ever persisted/returned.

### 5.2 Invalidation (dependency tracking)

When a **source** record changes (MongoDB change stream), the server MUST recompute the affected virtual rows — **without scanning the whole collection**. The definition declares this mapping via `affects(source, changedRecord) → virtualId[]`, so a source change resolves directly to the impacted virtual id(s), which are then recomposed. A virtual row that **leaves** its result (e.g. a profile is unpublished) must be **evicted** and, for scoped subscribers that had it, delivered as a removal.

> This is the same class of problem as any materialised view: the hard part is the **change → affected keys** mapping, which is why it is declared explicitly rather than inferred.

---

## 6. Scope enforcement (server-side, mandatory)

**The JWT / authenticated identity is an _input_, never the enforcement.** The client may request anything; the server returns only the intersection with the caller's scope.

On **every** query and (where live) **every** push, the server:

1. Validates the caller — for public, verifies the JWT **signature**, **`exp`**, and **audience**; for private, uses the authenticated user.
2. Resolves the **mandatory filter** via `scope(principal)` (public: derived from the JWT scope claim; private: from the user).
3. **AND-s** that filter into the query and gates the result set with it.

Scope MUST be enforced on **both** the read path and, for any live subscriber, the push path — enforcing only one leaks via the other. The **allowlist of publicly-readable virtual collections is default-deny**: a collection is reachable on the public channel only if explicitly allowlisted; everything else is rejected regardless of what is requested. The allowlist SHOULD also constrain **which fields are filterable**, so public `DataFilters` cannot be used to enumerate or fish for records.

---

## 7. Writes

Virtual collections are **read-only** through the collection API. `upsert`/`remove` against a virtual collection MUST **throw** — in **both** modes, so behaviour is symmetric and mode-blind.

Where a mutation is genuinely needed (including from a public page), it goes through an **explicit scoped server action**. Because the projection is server-only, that action:

- performs the write against the **source** collection(s),
- applies the caller's scope/validation,
- **re-projects** and **returns the affected virtual record(s)** in its response.

The client drops the returned record(s) into its read-model (§8), which is what makes read-after-write work without the component re-reading (§8.1).

---

## 8. The read-model / write-through invariant

Agnosticism does **not** come from "re-read after write". It comes from a single invariant true in both modes:

> **A write mutates the reactive read-model that queries observe; reactivity re-renders the observers. The component never explicitly re-reads.**

This is already how private mode behaves: `upsert()` writes the local DB → `onChange` fires → observing queries re-run → re-render. The DB is simply private mode's read-model.

Public mode gets the **same shape** with a different read-model:

- **Private read-model** = local SQLite + `onChange` (persistent, synced).
- **Public read-model** = an **in-memory normalised store with a change emitter** (ephemeral, not synced). One-shot fetches populate it; writes update it; observing queries re-run against it.

In both, a write does two things: **persist to the durable side** (local DB / scoped server action) **and** **update the read-model**, which notifies observers.

### 8.1 Read-after-write for virtual collections

Because projection is **server-only**, the client cannot re-project locally in **either** mode. So read-after-write on a virtual collection is a **server round-trip in both modes** — private mode is not magically instant here either (it awaits the server's re-projected push). The uniform contract:

- The scoped write action **returns the re-projected virtual record(s)** (§7); the client applies them to the read-model.
- Private mode MAY *also* receive them via the normal push; returning them from the action makes both paths immediate and identical.
- **Optimistic update** (write into the read-model eagerly, reconcile from the action response) layers on top **identically** in both modes.

### 8.2 The real cost

The public read-model must be **normalised and query-re-evaluating** — updating a record re-runs the predicate of every live query so the record enters/leaves the right result sets, exactly as `onChange` does against the DB. A naïve per-query snapshot cache will **not** propagate a write to the correct queries. The work item is therefore "a mini normalised reactive store for public mode", not "a fetch cache". It is small, but it is the piece that earns the agnosticism.

---

## 9. Subscriptions in public mode

A subscription is two halves: the **initial fetch** and the **ongoing listener**. Public mode keeps the first and drops the second — `subscribe()` runs the scoped query once, resolves, and **never emits again**; it "acts like an action". The hook's return shape (`data`/`loading`/`error`/`refetch`) is **identical** to private mode, so components cannot tell the difference.

Consequences:

- **No server-side listener** → no [§5.6](./design.md) per-client id set, no change-stream fan-out, no ephemeral-connection tracking. The public path is strictly **simpler** than the authenticated one, not a degraded copy of it. The public client reduces to: **JWT-in-memory + a scoped fetch + the in-memory read-model**.
- **Uniform unsubscribe contract.** Private returns "remove listener"; public returns a **no-op / abort-in-flight-fetch**. Same signature, so hook cleanup is mode-blind.
- **Param changes still refetch.** Changing `useQuery` filters while mounted re-runs the query — in public mode that is a fresh scoped fetch. Public pages stay fully interactive (filter/paginate); "no live push" ≠ "no interactivity" — updates come from *the caller's own* actions, not other users'.
- **Snapshot semantics.** Public data is stale-until-refetch. Combined with §8.1, a public write's action response updates the read-model, so the observing query still reflects the change without a listener.

---

## 10. Security considerations

The JWT **is** the authorization — whoever holds the URL holds the scope — and a URL is a leak-prone place for a bearer secret (browser history, `Referer` to third-party assets, CDN/proxy logs, copy-paste, shoulder-surf). Required hardening:

1. **Strip the JWT from the URL on load** — extract to memory, then `history.replaceState()`. Memory-only is compatible with "no persisted session" and removes the history/copy/Referer-linger vectors.
2. **`Referrer-Policy: no-referrer`** on public pages, so the token-bearing URL never rides a `Referer` to an external resource.
3. **Short `exp`** and the **narrowest possible scope claim** (specific collections + specific filter), so a leaked token is time-boxed and low-value.
4. **Decide revocation deliberately.** A pure stateless JWT cannot be revoked before `exp`. If "kill this link now" is required, add a server-side **`jti` blocklist** check — accepting the small loss of statelessness. The ULID + TTL + revoke primitives from the invite flow ([design.md §4.4](./design.md)) can back this.
5. **Enforcement is server-side (§6)** — never trust a scope computed or asserted by the client.
6. **Isolate ephemeral public state from authenticated state.** No local DB is opened for public visitors; the in-memory read-model is keyed by the JWT/scope identity (so two differently-scoped links in the same app cannot cross-contaminate) and dropped on navigate-away. If a visitor later authenticates on the same origin, authenticated data MUST NOT bleed into any public/ephemeral store.

---

## 11. Open questions / follow-ups

- **Scope claim shape.** Exact structure of the JWT scope claim and its mapping to `DataFilters` per collection.
- **`affects` ergonomics.** Whether the change → affected-key mapping can be derived from `keyOf` + source shape for common cases, reducing hand-written mappings.
- **Materialised vs compute-on-read** per collection: some low-churn public collections may be cheaper to compute on read (and CDN-cacheable via a plain HTTP path) than to materialise + invalidate. This can be a per-collection choice.
- **Allowlist declaration** location and the field-level filterability constraints (§6).

---

## 12. Summary

1. **Server-only virtual collections** — projection + row-scope, never audited (§2, §2.1); compose function is server-only and security-critical.
2. **Composite keys** collapsed to a deterministic string `id`, parts exposed as fields (§3).
3. **Private mode** — synced into the local encrypted DB via existing rails, read-only (§4).
4. **Public mode** — JWT-in-URL capability (stripped to memory, `no-referrer`, short `exp`, revocation decision), no DB, no session, one-shot scoped fetches that degrade subscriptions to actions (§4, §9, §10).
5. **Enforcement** — server derives the mandatory filter from JWT/user and AND-s it into every query (and any push); default-deny allowlist (§6).
6. **Agnostic consumer** via a mode-aware transport behind the existing hooks, unified by the **reactive read-model + write-through** invariant (§8).
