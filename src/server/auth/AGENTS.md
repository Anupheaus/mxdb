# Server auth (`src/server/auth/`)

Auth strategy classes, invite-link handshake, device management, and context hook.

## Overview

The auth layer implements a device-scoped, invite-link registration flow. The library supports multiple auth backends — WebAuthn (PRF-based passkey) and Google OAuth — through a common abstract base class (`AuthCollection`). Each strategy is a concrete subclass with its own MongoDB indexes and lookup methods. The invite-link handshake runs on a separate Socket.IO server mounted at `/{name}/register`.

This auth layer is intentionally isolated from the sync collection system: `AuthCollection` writes directly to a raw MongoDB collection (`mxdb_authentication`) and never goes through `ServerDbCollection` — auth records are never synced to clients.

## Contents

### Auth strategy classes
- `AuthCollection.ts` — abstract base class; implements `SocketAPIAuthStore<TRecord>`. Handles `mxdb_authentication` collection setup (TTL index on `expiresAt`, sparse index on `userId`), `requestId` ↔ `_id` mapping, and CRUD helpers (`findAllByUserId`, `create`, `update`, `delete`). Subclasses override `createIndexes()` to add strategy-specific indexes (call `super.createIndexes()` first). Every query resolves its `ServerDb` fresh via `useDb()` (not the db captured by the constructor) so per-connection routing (`connectionDbRouter.ts`'s `setDb`, run before the auth store is queried) redirects a long-lived `AuthCollection` instance at the current tenant DB; one initialized (collection-ensured + indexed) Mongo collection is cached per distinct `ServerDb` seen. The constructor argument is kept only as a fallback for callers outside any `provideDb`/`useDb` scope.
- `WebAuthnAuthCollection.ts` — concrete subclass for WebAuthn/passkey auth. Adds sparse indexes on `registrationToken` and `keyHash`; implements `WebAuthnAuthStore` interface.
- `GoogleOAuthAuthCollection.ts` — concrete subclass for Google OAuth. Implements `GoogleOAuthAuthStore` interface; currently no extra indexes beyond the base.

### Invite-link handshake
- `InviteNamespace.ts` — dedicated `socket.io` Server mounted at `/{name}/register` (separate from the main socket). Two-step flow: (1) client connects with `{ requestId }`, server validates invite and emits `INVITE_DETAILS`; (2) client emits `COMPLETE_REGISTRATION`, server stores key hash, issues initial token, emits `AUTH_SUCCESS`.

### Device management
- `deviceManagement.ts` — `getDevices`, `enableDevice`, `disableDevice`, `deleteDevice`, `expireStalePendingInvites`. Registered on **`useAuthDevices()`** at startup; also exposed on the **`ServerInstance`** from `startServer`.
- `authDevicesContext.ts` — module-level `AuthDevicesApi` store; `setAuthDevices` (called from `startServer`), `useAuthDevices()` for handlers.
- `useAuthDevices.ts` — re-exports `authDevicesContext` (`listForUser`, `createInvite`, `setEnabled`, `deleteDevice`, `expireStalePendingInvites`, `findById`, `create`, `update`).
- `parseSessionTokenFromHandshake.ts` — reads `nexus_session` / `socketapi_session` cookies, then handshake `sessionToken` (used by `startAuthenticatedServer`).

### Dev tooling
- `registerDevAuthRoute.ts` — registers a `POST /{name}/dev/signin` Koa route that issues a dev auth token without WebAuthn. **Excluded in `NODE_ENV=production`** — this is the server-side counterpart to `setupBrowserTools`'s `setDevAuth`.

### Device management context
- `authDevicesContext.ts` — `AuthDevicesApi` interface (`listForUser`, `createInvite`, `setEnabled`, `deleteDevice`, `expireStalePendingInvites`, `findById`, `create`, `update`) plus a module-level singleton pattern: `setAuthDevices(api)` registers the implementation at startup; `useAuthDevices()` returns it and throws if called before registration
- `useAuthDevices.ts` — barrel re-export of `AuthDevicesApi`, `setAuthDevices`, and `useAuthDevices`

### Session token parsing
- `parseSessionTokenFromHandshake.ts` — `parseSessionTokenFromHandshake(input)` — reads the session token from socket handshake cookies; checks both `nexus_session` and `socketapi_session` cookie names (the latter kept for backward compatibility after the socket-api → nexus rename); falls back to `input.sessionTokenFromAuth` if no cookie matches

### Auth context within handlers
Auth context (userId, token for the current socket client) is not a file in this directory. Access it via `useClient()` in [`../hooks/useClient.ts`](../hooks/useClient.ts) — see [hooks/AGENTS.md](../hooks/AGENTS.md).

## Architecture

### Auth strategy inheritance

```
SocketAPIAuthStore (socket-api interface)
  └── AuthCollection<TRecord> (abstract base — mxdb_authentication collection)
        ├── WebAuthnAuthCollection  (passkey / PRF key-based)
        └── GoogleOAuthAuthCollection  (OAuth token-based)
```

`startAuthenticatedServer` constructs the appropriate `AuthCollection` subclass(es) and passes them to the socket-api server config. Which strategies are active depends on what the host app configures.

### Invite link flow (WebAuthn)
1. Host app calls `instance.createInvite(userId, baseUrl)` → stores a time-limited invite record → returns a URL.
2. Client opens URL → calls `useMXDBInvite()(url)` → connects to `/{name}/register` → WebAuthn prompt.
3. `InviteNamespace` validates invite (rate limit, single-use, TTL) → issues auth token.
4. Token stored encrypted in client SQLite; rotated automatically in the background.

## Ambiguities and gotchas

- **`AuthCollection` is NOT a `ServerDbCollection`** — it bypasses the sync pipeline entirely. Do not pass auth records to `extendCollection` hooks or expect them to appear in change-stream events.
- **Dev auth route is excluded in production** — `registerDevAuthRoute.ts` is only registered when `NODE_ENV !== 'production'`. The client's `setupBrowserTools` `setDevAuth` helper will silently fail in prod because the endpoint does not exist.
- **Single `mxdb_authentication` MongoDB collection** — all auth strategy records share one collection (`mxdb_authentication`). Strategy subclasses distinguish records by their schema shape, not by collection name.
- **`AuthCollection` queries the CURRENT `useDb()`, not the constructor db** — a single `AuthCollection` instance is constructed once at startup and reused for every connection; each query re-resolves `useDb()` so per-connection tenant routing (Phase 2a's `setDb`) works. Only falls back to the constructor-captured db when `useDb()` throws (no scope at all — e.g. ad-hoc tooling outside `provideDb`).

## Related

- [../AGENTS.md](../AGENTS.md) — parent server directory
- [../hooks/AGENTS.md](../hooks/AGENTS.md) — `useClient()` provides auth context (userId, token) inside handlers
- [../providers/db/AGENTS.md](../providers/db/AGENTS.md) — `ServerDb`/`useDb()`; `AuthCollection`'s constructor argument is now only a fallback
- [../../client/auth/deriveKey.ts](../../client/auth/deriveKey.ts) — client-side PRF key derivation (counterpart to WebAuthn server auth)
