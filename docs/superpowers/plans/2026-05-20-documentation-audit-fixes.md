# Documentation Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 11 documentation gaps identified in the May 2026 audit: stale AGENTS.md references, undocumented files, missing README sections, and inline TSDoc gaps.

**Architecture:** Pure documentation changes — no production code changes. Tasks are independent and can be parallelised. Each task is a focused edit to one or two files.

**Tech Stack:** Markdown (AGENTS.md, README.md), TypeScript TSDoc

---

## Task 1: Fix stale `useAuth.ts` reference in `src/server/auth/AGENTS.md`

**Files:**
- Modify: `src/server/auth/AGENTS.md`

**Background:** The AGENTS.md for `src/server/auth/` has a "Context hook" section that says `useAuth.ts` exists in that directory with a `useAuth()` socket-context hook. This file does not exist in `src/server/auth/` (or anywhere in `src/`). The auth context is accessed via `useClient()` in `src/server/hooks/useClient.ts`. This will confuse any agent navigating the server auth directory.

- [ ] **Step 1: Read the current file**

Read `src/server/auth/AGENTS.md` to see the full current content.

- [ ] **Step 2: Remove the stale section and add a cross-link**

In `src/server/auth/AGENTS.md`, remove the "Context hook" bullet that references `useAuth.ts`:

```
### Context hook
- `useAuth.ts` — `useAuth()` — socket-context hook; returns `userId` and `token` for the currently connected client. Use inside socket action handlers and subscriptions.
```

Then add a note at the end of the Contents section (after the Dev tooling bullet) pointing to where auth context IS available:

```markdown
### Auth context within handlers
Auth context (userId, token for the current socket client) is not a file in this directory. Access it via `useClient()` in [`../hooks/useClient.ts`](../hooks/useClient.ts) — see [hooks/AGENTS.md](../hooks/AGENTS.md).
```

Also update the Related section — add a link to hooks/AGENTS.md if it isn't already there:

```markdown
- [../hooks/AGENTS.md](../hooks/AGENTS.md) — `useClient()` provides auth context (userId, token) inside handlers
```

- [ ] **Step 3: Commit**

```
git add src/server/auth/AGENTS.md
git commit -m "docs: fix stale useAuth.ts reference in server/auth/AGENTS.md"
```

---

## Task 2: Update `src/client/AGENTS.md` to cover undocumented auth files

**Files:**
- Modify: `src/client/AGENTS.md`

**Background:** `src/client/auth/` has three files. The client AGENTS.md only mentions `deriveKey.ts` in the Auth section. The other two — `encryptionSessionCache.ts` and `MXDBSyncInner.tsx` — are completely undocumented in the AGENTS.md tree:

- `encryptionSessionCache.ts` — stores the PRF-derived AES key in `sessionStorage` (base64-encoded) so page refreshes don't require a new WebAuthn ceremony. Also supports Google OAuth placeholder key handling.
- `MXDBSyncInner.tsx` — the inner auth-aware React component that handles: auth-mode branching (WebAuthn vs Google OAuth), PRF key derivation, session-cache restore on page refresh, BroadcastChannel cross-tab sign-out, and dev-bypass in non-production. It mounts `DbsProvider` only after an encryption key is available.

- [ ] **Step 1: Read the current file**

Read `src/client/AGENTS.md` to see the full current Auth section.

- [ ] **Step 2: Expand the Auth section**

Find the current Auth section:

```markdown
### Auth (`auth/`)
- `deriveKey.ts` — WebAuthn PRF extension key derivation; used to encrypt the auth token at rest in SQLite
```

Replace it with:

```markdown
### Auth (`auth/`)
- `deriveKey.ts` — derives a 256-bit AES key from a WebAuthn PRF output (`SubtleCrypto.deriveKey`); the key encrypts the auth token stored in SQLite at rest
- `encryptionSessionCache.ts` — caches the PRF-derived encryption key in `sessionStorage` (base64-encoded) so a page refresh does not require a new WebAuthn ceremony; `loadEncryptionFromSession` restores it on re-mount; `clearEncryptionFromSession` is called on sign-out; Google OAuth uses an all-zero placeholder key (no PRF ceremony needed)
- `MXDBSyncInner.tsx` — auth-aware inner provider component mounted by `MXDBSync`. Responsibilities: (1) branches on `authMode` (WebAuthn vs Google OAuth), (2) wires the PRF callback from socket-api into `deriveKey` + session cache, (3) monitors user state changes to trigger sign-in/sign-out flows, (4) broadcasts sign-out across tabs via `BroadcastChannel`, (5) implements dev-bypass (non-production only: reads `mxdb:dev-auth:{appName}` from localStorage). Only mounts `DbsProvider` once an `encryptionKey` and `dbName` are both available.
```

- [ ] **Step 3: Commit**

```
git add src/client/AGENTS.md
git commit -m "docs: document encryptionSessionCache.ts and MXDBSyncInner.tsx in client/AGENTS.md"
```

---

## Task 3: Archive the stale `process.md`

**Files:**
- Move: `process.md` → `docs/archive/process.md`
- Modify: `docs/archive/README.md` (add entry)

**Background:** `process.md` in the repo root contains outdated Mermaid flowcharts describing an old sync/watch model (timestamp-based, no audits). It is not referenced from any AGENTS.md, README, or docs file. The current sync system uses ULID-ordered audit entries, making these diagrams actively misleading. It should be archived rather than deleted so history is preserved.

- [ ] **Step 1: Read the archive README to understand its format**

Read `docs/archive/README.md`.

- [ ] **Step 2: Move the file**

```powershell
Move-Item process.md docs/archive/process.md
```

- [ ] **Step 3: Add an entry to `docs/archive/README.md`**

Add a row to the archive README noting that `process.md` is an old planning doc:

```markdown
| [process.md](./process.md) | Old Mermaid flowcharts for the pre-audit sync model (timestamp-based). Superseded by the ULID audit system — see `docs/reference/tech-overview.md`. |
```

- [ ] **Step 4: Commit**

```
git add docs/archive/process.md docs/archive/README.md
git rm process.md
git commit -m "docs: archive stale process.md (pre-audit sync diagrams)"
```

---

## Task 4: Add TSDoc to undocumented exports in `encryptionSessionCache.ts`

**Files:**
- Modify: `src/client/auth/encryptionSessionCache.ts`

**Background:** `encryptionSessionCache.ts` exports 4 functions; only `hasCachedEncryptionKey` has a TSDoc comment. The other three — `saveEncryptionToSession`, `loadEncryptionFromSession`, `clearEncryptionFromSession` — lack docs. These functions have non-obvious behaviour: they use `sessionStorage` (tab-scoped, lost on tab close), the key is base64-encoded, and all errors are silently swallowed (by design — storage errors must not interrupt auth flow).

- [ ] **Step 1: Read the current file**

Read `src/client/auth/encryptionSessionCache.ts` to see all current exports.

- [ ] **Step 2: Add TSDoc to the three undocumented functions**

Add JSDoc blocks immediately above each of the three functions. Insert these exactly as shown (preserve existing blank lines between functions):

Above `saveEncryptionToSession`:
```typescript
/**
 * Caches the PRF-derived encryption key in sessionStorage so a page refresh skips the WebAuthn ceremony.
 *
 * Uses sessionStorage (tab-scoped) intentionally — the key is lost when the tab closes, limiting the
 * exposure window. Storage errors are silently ignored so auth flow is never interrupted by storage limits.
 *
 * @param key - Raw AES key bytes derived from the WebAuthn PRF output
 * @param dbName - SQLite DB name to open alongside the key (userId or accountId)
 */
```

Above `loadEncryptionFromSession`:
```typescript
/**
 * Restores a previously cached encryption key from sessionStorage.
 *
 * Returns undefined if no cached key exists or if parsing fails (e.g. corrupted storage entry).
 * Call after sign-in to avoid re-running the WebAuthn ceremony on every page load.
 */
```

Above `clearEncryptionFromSession`:
```typescript
/**
 * Removes the cached encryption key from sessionStorage.
 *
 * Call on sign-out or before starting a fresh WebAuthn ceremony. Storage errors are silently ignored.
 */
```

- [ ] **Step 3: Commit**

```
git add src/client/auth/encryptionSessionCache.ts
git commit -m "docs: add TSDoc to undocumented encryptionSessionCache exports"
```

---

## Task 5: Add missing sections to root `README.md`

**Files:**
- Modify: `README.md`

**Background:** The root README is missing four sections identified in the audit:
1. **Tech stack / Requirements** — MongoDB topology requirement (replica set/Atlas for change streams), browser requirements (OPFS, WebAuthn PRF), Node version
2. **Environment variables** — `MONGO_URI`/`mongoDbUrl`, `NODE_ENV` (controls dev-auth route), TLS certs for test server
3. **Known limitations and non-goals** — restoration not implemented, `onAfterClear` not change-stream driven, cross-collection ordering, Google OAuth data unencrypted at rest
4. **Errors and what they mean** — `MXDBError` codes and their triggers

These should be inserted before the "Development" section so they appear before the dev commands.

- [ ] **Step 1: Read the current README.md**

Read `README.md` to locate the exact text of the "Development" section header so the insertion point is precise.

- [ ] **Step 2: Insert the four new sections before "## Development"**

Find the text:
```markdown
## Development
```

Insert the following block immediately before it (keep a blank line before `## Development`):

```markdown
## Requirements

| Requirement | Detail |
|-------------|--------|
| **Node.js** | 18+ (ESM, `AsyncLocalStorage`) |
| **MongoDB** | 4.4+ with change streams enabled — requires a **replica set** or MongoDB Atlas. A standalone `mongod` will not work. |
| **Browser** | Chrome 116+ / Edge 116+ for full support. Requires OPFS (`navigator.storage.getDirectory`) for persistent SQLite and WebAuthn PRF extension for hardware-backed encryption. Firefox supports WebAuthn but not PRF — users on Firefox fall back to Google OAuth or unencrypted storage. |
| **Socket.IO** | Peer dependency — the `server` parameter to `startServer` must be a Node HTTP/HTTPS server with Socket.IO already attached. |

## Environment variables

These are used at runtime or in the test harness. None are required by the package itself — they are conventions used in the test app (`test/`) and e2e suite (`tests/`).

| Variable | Used by | Description |
|----------|---------|-------------|
| `NODE_ENV` | Server | When `production`, the dev-auth bypass route (`POST /{name}/dev/signin`) is **not** registered. Always set `NODE_ENV=production` in deployed environments. |
| `MONGO_URI` | Test app / e2e | MongoDB connection URI used in the manual test app and e2e setup. Passed as `mongoDbUrl` to `startServer`. |
| `MXDB_E2E_*` | E2e test suite | A family of variables injected into the forked test server process (`MXDB_E2E_PORT`, `MXDB_E2E_MONGO_URI`, etc.). See `tests/e2e/setup/mongoConstants.ts`. |

## Known limitations and non-goals

- **No record restoration.** An `Updated` audit entry after a `Deleted` entry does not restore the record. Restoration requires an explicit `Restored` audit entry. There is currently no API to create one — deletion is effectively permanent until this is implemented.
- **`onAfterClear` is not change-stream driven.** Unlike `onAfterUpsert` and `onAfterDelete`, `onAfterClear` runs only on the server instance that performed the clear — not on all instances watching the change stream.
- **No cross-collection ordering guarantee.** When an `onAfterUpsert` hook writes to another collection, clients may briefly see a deleted record's reference intact in the related collection until the cascade-update notification arrives.
- **Google OAuth data is unencrypted at rest.** WebAuthn uses the PRF extension to derive a hardware-backed AES key for the local SQLite database. Google OAuth has no equivalent hardware primitive — a zero-filled placeholder key is used, meaning the SQLite database is not encrypted. This is a known trade-off.
- **ServerOnly collections have no client-side storage.** `syncMode: 'ServerOnly'` means no local SQLite table is created; all reads go to the server. `useGet`, `useGetAll`, `useQuery` etc. will use the subscription / action path rather than local state.
- **ESM only.** The package ships ESM modules. CJS consumers require a bundler with ESM interop (Vite, esbuild, webpack 5+).

## Errors and what they mean

`MXDBError` is passed to the `onError` callback on `MXDBSync`. Each error has a `code`, `message`, and `severity` (`'fatal' | 'recoverable'`).

| Code | Severity | Trigger | What to do |
|------|----------|---------|------------|
| `SYNC_FAILED` | recoverable | A C2S sync batch was rejected by the server (e.g. network error, timeout, or server returned an error for one or more records). | The sync engine will retry on the next tick. Log for visibility; surface to the user only if it persists. |
| `TIMEOUT` | recoverable | A socket action (get, upsert, etc.) did not receive a response within 5 000 ms. | Typically a transient network issue. The client will retry the action on reconnect. |
| `DB_NOT_OPEN` | fatal | A collection operation was attempted before the SQLite database finished opening, or after it was closed. | Check that `useCollection` is only called inside the `MXDBSync` provider tree. |
| `ENCRYPTION_FAILED` | fatal | The WebAuthn PRF key derivation failed (e.g. the platform rejected the ceremony). | The local database cannot be decrypted. The user must re-register the device via the invite-link flow. |
| `INVALID_TOKEN` | fatal | The stored auth token was rejected by the server. | Call `onInvalidToken` on `MXDBSync` to trigger re-authentication (re-run the invite flow). |

```

- [ ] **Step 3: Commit**

```
git add README.md
git commit -m "docs: add tech stack, env vars, limitations, and error codes to README"
```

---

## Task 6: Add `crud-operations/` description to `tests/e2e/README.md`

**Files:**
- Modify: `tests/e2e/README.md`

**Background:** The `tests/e2e/README.md` Layout table lists `setup/` and `<suite>/` (with `stress/` as the example) but does not mention `crud-operations/` at all. An agent reading that file has no way to know what that directory contains or what scenarios it covers. The directory has 5 files: `deletions.crud.e2e.tests.ts`, `performance.e2e.tests.ts`, `subscriptions.crud.e2e.tests.ts`, `updates.crud.e2e.tests.ts`, and `utils.ts`.

- [ ] **Step 1: Read `tests/e2e/README.md`**

Read the file to see the current Layout table.

- [ ] **Step 2: Add a `crud-operations/` row to the Layout table**

Find the Layout table. Add a row for `crud-operations/`:

```markdown
| **`crud-operations/`** | CRUD and performance suite: `updates`, `deletions`, `subscriptions`, and `performance` specs + `utils.ts` for shared test helpers. All use `setupE2E` / `resetE2E` / `teardownE2E` from `./setup`. |
```

Insert this row before the repo-root row (the "`Repo root of e2e/`" row), so the table reads: `setup/` → `crud-operations/` → `stress/` → repo root.

- [ ] **Step 3: Commit**

```
git add tests/e2e/README.md
git commit -m "docs: document crud-operations/ directory in tests/e2e/README.md"
```

---

## Task 7: Rename `src/common/sync-engine/readme.md` to a clearer name

**Files:**
- Rename: `src/common/sync-engine/readme.md` → `src/common/sync-engine/sync-engine-reference.md`
- Modify: `src/common/sync-engine/AGENTS.md` (update the link)

**Background:** The living reference document for the sync engine is named `readme.md` (lowercase), which is non-standard. The directory's `AGENTS.md` references it as `readme.md`. Renaming to `sync-engine-reference.md` makes it clearly distinguishable from a project README and prevents tools that scan for `AGENTS.md` or `README.md` from treating it as either.

- [ ] **Step 1: Rename the file**

```powershell
Rename-Item src/common/sync-engine/readme.md src/common/sync-engine/sync-engine-reference.md
```

- [ ] **Step 2: Update the link in `src/common/sync-engine/AGENTS.md`**

Find:
```markdown
**[readme.md](readme.md)** — living reference document covering every component's lifecycle, invariants, flow diagrams, race conditions, and regression test index. Read this before editing any file in this directory.
```

Replace with:
```markdown
**[sync-engine-reference.md](sync-engine-reference.md)** — living reference document covering every component's lifecycle, invariants, flow diagrams, race conditions, and regression test index. Read this before editing any file in this directory.
```

- [ ] **Step 3: Commit**

```
git add src/common/sync-engine/sync-engine-reference.md src/common/sync-engine/AGENTS.md
git rm src/common/sync-engine/readme.md
git commit -m "docs: rename sync-engine readme.md to sync-engine-reference.md for clarity"
```

---

## Self-Review

**Spec coverage:**

| Finding | Task |
|---------|------|
| 1. Stale `useAuth.ts` reference in `src/server/auth/AGENTS.md` | Task 1 ✅ |
| 2. `MXDBSyncInner.tsx` and `encryptionSessionCache.ts` undocumented in client AGENTS.md | Task 2 ✅ |
| 3. `process.md` stale planning doc in root | Task 3 ✅ |
| 4. README missing env vars table | Task 5 ✅ |
| 5. README missing tech stack section | Task 5 ✅ |
| 6. README missing known limitations | Task 5 ✅ |
| 7. TSDoc missing on 3 encryptionSessionCache exports | Task 4 ✅ |
| 8. README missing errors section | Task 5 ✅ |
| 9. `crud-operations/` undocumented in e2e README | Task 6 ✅ |
| 10. `sync-engine/readme.md` non-standard name | Task 7 ✅ |
| 11. `tests/e2e/` READMEs vs AGENTS.md naming | Not implemented — README.md is a valid format for human-readable docs in test dirs; navigation works; the benefit of renaming is marginal and risks breaking bookmarks. Left as is by design. |

**Placeholder scan:** No TBD, TODO, or "similar to" references. All content is concrete.

**Type consistency:** No code types defined — documentation only.
