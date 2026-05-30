# Client layer (`src/client/`)

React provider, hooks, SQLite-backed local store, and client-side sync.

## Overview

The client layer wraps the app in `<MXDBSync>` (the root provider), exposes `useCollection` for all collection operations, and handles offline-first storage, real-time updates, WebAuthn auth, and conflict resolution.

Local state lives in a per-device SQLite database (OPFS shared worker in browsers, in-memory in Node/tests). The `dbs` provider owns this database. Sync to/from the server flows through `client-to-server` and `server-to-client` providers which wrap the sync-engine's `ClientDispatcher` and `ClientReceiver`.

## Contents

### Root exports
- `MXDBSync.tsx` — root React provider; mount once at app root. Accepts `collections`, `host`, auth callbacks, error handlers.
- `useMXDB.ts` — `useMXDB()` — connection state: `isConnected`, `clientId`, `isSynchronising`, `isDbReady`, `waitForDbReady()`, test disconnect helpers
- `useRecord.ts` — `useRecord(id | localCopy, collection)` — optimistic form-edit hook with server-rebase semantics
- `internalModels.ts` — client-private types

### Hooks (`hooks/`)
See [hooks/AGENTS.md](hooks/AGENTS.md) for the full directory. Key exports:
- `useCollection(collection)` — primary raw API (imperative + reactive). See [hooks/useCollection/AGENTS.md](hooks/useCollection/AGENTS.md).
- `createUseRecord(name, collection, options)` — factory: returns a named single-record hook with auto-save, hydration, helpers, and extensions.
- `createUseRecords(name, collection, options?)` — factory: returns a named collection hook with a reactive `.query()` sub-hook.
- `useAuth()` — auth state for the current device
- `useMXDBSignOut()` — sign out of current device
- `useMXDBUserId()` — current user id

### Local database (`db-worker/`)
SQLite worker architecture. See [db-worker/AGENTS.md](db-worker/AGENTS.md).

### Providers (`providers/`)
React context providers composing the `MXDBSync` tree. See [providers/AGENTS.md](providers/AGENTS.md).

### Auth (`auth/`)
- `deriveKey.ts` — derives a 256-bit AES key from a WebAuthn PRF output (`SubtleCrypto.deriveKey`); the key encrypts the local SQLite database at rest
- `encryptionSessionCache.ts` — caches the PRF-derived encryption key in `sessionStorage` (base64-encoded) so a page refresh does not require a new WebAuthn ceremony; `loadEncryptionFromSession` restores it on re-mount; `clearEncryptionFromSession` is called on sign-out; Google OAuth uses an all-zero placeholder key (no PRF ceremony needed); `hasCachedEncryptionKey` returns true if a key is cached for the given user (used to skip the WebAuthn ceremony on re-mount)
- `MxdbReadyContext.ts` — context providing `waitForDbReady()` / `getIsDbReady()`; resolved by `MXDBSyncInner` when the encryption key is available
- `dbReadyWait.ts` — `createDbReadyWaitHandle()` — promise + timeout logic backing `waitForDbReady()` (tested in `dbReadyWait.tests.ts`)
- `MXDBSyncInner.tsx` — auth-aware inner provider component mounted by `MXDBSync`. Responsibilities: (1) branches on `authMode` (webauthn vs google-oauth), (2) wires the PRF callback from socket-api into key derivation and session cache, (3) monitors user state changes to trigger sign-in/sign-out flows, (4) broadcasts sign-out across tabs via `BroadcastChannel`, (5) implements dev-bypass (non-production only: reads `mxdb:dev-auth:{appName}` from localStorage), (6) exposes `waitForDbReady()` so consumers can await DB initialisation without polling. Only mounts `DbsProvider` once an `encryptionKey` and `dbName` are both available.

### Components (`components/UseRecord/`)
- `UseRecordContext.ts` — React context carrying the `useRecord` instance
- `useRecord.ts` — core implementation of `useRecord`
- `UseRecordWithRecord.tsx` — variant that accepts a full record object
- `UseRecordWithRecordId.tsx` — variant that accepts a record id
- `UseRecord.tsx` — top-level dispatcher (currently commented out / work in progress)

### Utilities (`utils/`)
- `actionTimeout.ts` — `withTimeout(promise, ms, label)` races a promise against a timeout rejection; `ACTION_TIMEOUT_MS = 5000` is the default socket action timeout. Used wherever socket calls could stall indefinitely.
- `setupBrowserTools.ts` — `setupBrowserTools(appName)` attaches `window.mxdb.listDatabases()` (OPFS database inspector) and, in non-production builds, `setDevAuth` / `clearDevAuth` dev-auth shortcuts. Called at app startup.

## Architecture

`MXDBSync` mounts a nested provider stack (socket → dbs → collection → C2S → S2C → conflictResolution). Order matters: providers lower in the tree access context from providers mounted above them. The `dbs` provider must sit above all collection and sync providers.

## Related

- [hooks/AGENTS.md](hooks/AGENTS.md) — all client hooks (factories, primitives, utilities)
- [hooks/useCollection/AGENTS.md](hooks/useCollection/AGENTS.md) — collection API
- [db-worker/AGENTS.md](db-worker/AGENTS.md) — SQLite worker
- [providers/AGENTS.md](providers/AGENTS.md) — React provider tree
- [../common/AGENTS.md](../common/AGENTS.md) — shared types and sync engine
