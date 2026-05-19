# HTTP Security Middleware Design

**Date:** 2026-04-19  
**Status:** Approved  
**Scope:** `socket-api` (core middleware) + `mxdb` (config surface + invite route cleanup)

---

## Goal

Protect all HTTP REST endpoints — both library-internal and consumer-registered — from DDoS, abuse, and common intrusion vectors. Applied globally by default with no consumer effort required, but tunable via config. Per-route overrides deep-merge with global settings.

Deployment context: behind Cloudflare, but defence-in-depth at the Node.js layer.

---

## Config Types

Lives in `socket-api`. All fields optional — omitting any field uses the default.

```ts
interface RateLimitConfig {
  maxRequests?: number;   // default: 100
  windowMs?: number;      // default: 60_000 (1 min)
  message?: string;       // default: 'Too many requests'
}

interface CorsConfig {
  allowedOrigins?: string | string[] | RegExp;  // default: same-origin only
  allowedMethods?: string[];                     // default: ['GET','POST','PUT','DELETE','OPTIONS']
  allowedHeaders?: string[];                     // default: ['Content-Type','Authorization']
  maxAgeSeconds?: number;                        // default: 600
}

interface SecurityConfig {
  rateLimit?: RateLimitConfig | false;  // false = disabled for all routes
  cors?: CorsConfig | false;
  maxBodySizeKb?: number;               // default: 512
  trustedProxyHops?: number;            // default: 1 (Cloudflare single-hop)
  securityHeaders?: boolean;            // default: true
}
```

`DeepPartial<SecurityConfig>` is used for per-route overrides — no separate type needed.

---

## Global Middleware (`socket-api` — `setupKoa.ts`)

Applied inside `setupKoa()` immediately after `bodyParser`, before any routes. Every request passes through regardless of origin (internal library routes or consumer-registered routes).

Middleware stack in execution order:

### 1. Trusted Proxy
Sets `ctx.ip` from `X-Forwarded-For` skipping `trustedProxyHops` edge hops, so Cloudflare's forwarded client IP is used — not the Cloudflare edge IP. Koa's built-in `app.proxy = true` + `app.proxyIpHeader` handles this.

### 2. Security Headers
Set unconditionally when `securityHeaders: true` (default):

| Header | Value |
|---|---|
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `X-XSS-Protection` | `0` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |

### 3. CORS
Validates `Origin` header against `allowedOrigins`. On mismatch → `403`. Handles `OPTIONS` preflight with `204`. Sets `Access-Control-*` headers on all passing requests.

### 4. Rate Limiter
In-memory, keyed by `ctx.ip`. Per-window counter with auto-expiry. On exceeded limit → `429` JSON response. Replaces the existing `inviteRateLimiter` singleton in `mxdb`.

The global middleware stores the resolved effective config on `ctx.state.security` for per-route middleware to read.

### 5. Body Size
Passed into `bodyParser` as `jsonLimit` / `formLimit` (`${maxBodySizeKb}kb`).

---

## Per-Route Override (`socket-api` — new export)

```ts
// socket-api/src/server/index.ts
export function withSecurity(overrides: DeepPartial<SecurityConfig>): Koa.Middleware
```

Usage in `onRegisterRoutes` or inside `mxdb` route registration:

```ts
router.get('/sensitive', withSecurity({ rateLimit: { maxRequests: 10 } }), handler)
router.post('/upload',   withSecurity({ maxBodySizeKb: 10_000 }), handler)
router.get('/health',    withSecurity({ rateLimit: false }), handler)
```

**Merge semantics:** Deep merge at every level. Per-route values win over global, but only for keys explicitly set. Example: `{ rateLimit: { maxRequests: 10 } }` merges with global's `windowMs` and `message` — only `maxRequests` is overridden.

**What per-route middleware re-evaluates:**
- Rate limit (different threshold per route makes sense)
- Body size (e.g. upload routes need higher limit) — note: `bodyParser` runs globally before route middleware, so the body is already parsed by the time `withSecurity` executes. The per-route body size check validates `ctx.request.length` against the overridden limit and rejects with `413` if exceeded. The global `maxBodySizeKb` still acts as the hard ceiling at parse time.

**What per-route middleware does NOT re-evaluate:**
- Security headers (response headers already sent by global layer)
- CORS (global concern, not per-route)
- Trusted proxy (set once at app level)

---

## Error Responses

All rejections return JSON:

| Trigger | Status | Body |
|---|---|---|
| Rate limit exceeded | `429` | `{ error: 'Too many requests' }` |
| CORS origin rejected | `403` | `{ error: 'CORS: origin not allowed' }` |
| Body too large | `413` | `{ error: 'Request body too large' }` |
| OPTIONS preflight | `204` | *(no body, CORS headers only)* |

---

## Scope of Changes

### `socket-api`
- `src/server/providers/koa/setupKoa.ts` — add security middleware stack; accept `SecurityConfig` param
- `src/server/startServer.ts` — add `security?: SecurityConfig` to `ServerConfig`; pass to `setupKoa`
- `src/server/security/` — new directory:
  - `SecurityConfig.ts` — type definitions + defaults
  - `createSecurityMiddleware.ts` — global middleware factory
  - `withSecurity.ts` — per-route override middleware factory
  - `RateLimiter.ts` — in-memory rate limiter (moved/generalised from `mxdb`)
- `src/server/index.ts` — export `withSecurity`, `SecurityConfig`

### `mxdb`
- `src/server/internalModels.ts` — add `security?: SecurityConfig` to `ServerConfig`
- `src/server/startAuthenticatedServer.ts` — pass `security` through to `socket-api` `startServer()`
- `src/server/auth/registerAuthInviteRoute.ts` — replace manual `inviteRateLimiter.check()` calls with `withSecurity({ rateLimit: { maxRequests: 5, windowMs: 900_000 } })` applied at the route level
- `src/server/auth/RateLimiter.ts` — **deleted** (replaced by the global system)

---

## Out of Scope (separate task)
- Socket.IO connection rate limiting
- Per-socket action throttling
