# Server auth (`src/server/auth/`)

Auth strategy classes, invite-link handshake, device management, and context hook.

## Overview

The auth layer implements a device-scoped, invite-link registration flow. The library supports multiple auth backends — WebAuthn (PRF-based passkey) and Google OAuth — through a common abstract base class (`AuthCollection`). Each strategy is a concrete subclass with its own MongoDB indexes and lookup methods. The invite-link handshake runs on a separate Socket.IO server mounted at `/{name}/register`.

This auth layer is intentionally isolated from the sync collection system: `AuthCollection` writes directly to a raw MongoDB collection (`mxdb_authentication`) and never goes through `ServerDbCollection` — auth records are never synced to clients.

## Contents

### Auth strategy classes
- `AuthCollection.ts` — abstract base class; implements `SocketAPIAuthStore<TRecord>`. Handles `mxdb_authentication` collection setup (TTL index on `expiresAt`, sparse index on `userId`), `requestId` ↔ `_id` mapping, and CRUD helpers (`findAllByUserId`, `create`, `update`, `delete`). Subclasses override `createIndexes()` to add strategy-specific indexes (call `super.createIndexes()` first).
- `WebAuthnAuthCollection.ts` — concrete subclass for WebAuthn/passkey auth. Adds sparse indexes on `registrationToken` and `keyHash`; implements `WebAuthnAuthStore` interface.
- `GoogleOAuthAuthCollection.ts` — concrete subclass for Google OAuth. Implements `GoogleOAuthAuthStore` interface; currently no extra indexes beyond the base.

### Invite-link handshake
- `InviteNamespace.ts` — dedicated `socket.io` Server mounted at `/{name}/register` (separate from the main socket). Two-step flow: (1) client connects with `{ requestId }`, server validates invite and emits `INVITE_DETAILS`; (2) client emits `COMPLETE_REGISTRATION`, server stores key hash, issues initial token, emits `AUTH_SUCCESS`.

### Device management
- `deviceManagement.ts` — `getDevices(db, userId)`, `enableDevice(db, requestId)`, `disableDevice(db, requestId)`. Called by the `ServerInstance` surface exposed from `startServer`.

### Dev tooling
- `registerDevAuthRoute.ts` — registers a `POST /{name}/dev/signin` Koa route that issues a dev auth token without WebAuthn. **Excluded in `NODE_ENV=production`** — this is the server-side counterpart to `setupBrowserTools`'s `setDevAuth`.

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

## Related

- [../AGENTS.md](../AGENTS.md) — parent server directory
- [../hooks/AGENTS.md](../hooks/AGENTS.md) — `useClient()` provides auth context (userId, token) inside handlers
- [../providers/db/AGENTS.md](../providers/db/AGENTS.md) — `ServerDb` passed to `AuthCollection` constructor
- [../../client/auth/deriveKey.ts](../../client/auth/deriveKey.ts) — client-side PRF key derivation (counterpart to WebAuthn server auth)
