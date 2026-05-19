# HTTP Security Middleware Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add global HTTP security middleware (rate limiting, security headers, CORS, body-size limits) to `socket-api`'s Koa server, plus a `withSecurity()` per-route override, and then wire it through `mxdb-sync` replacing the existing ad-hoc invite rate limiter.

**Architecture:** All protection is applied as Koa middleware inside `setupKoa()` in `socket-api` so every HTTP request — internal library routes and consumer-registered routes — passes through it before any handler runs. Per-route overrides are provided via a `withSecurity(overrides)` middleware factory that deep-merges onto the global resolved config. `mxdb-sync` simply passes its `security` field through to `socket-api` (already works via config spread) and drops its bespoke `RateLimiter.ts`.

**Tech Stack:** TypeScript, Koa 2, koa-bodyparser, Vitest — no new npm dependencies required.

---

## File Map

### `socket-api` — new files
| Path | Responsibility |
|---|---|
| `src/server/security/SecurityConfig.ts` | Type definitions, defaults, `resolveSecurityConfig`, `mergeSecurityConfig` |
| `src/server/security/SecurityConfig.tests.ts` | Tests for resolve + merge |
| `src/server/security/RateLimiter.ts` | In-memory sliding-window rate limiter class |
| `src/server/security/RateLimiter.tests.ts` | Unit tests for rate limiter |
| `src/server/security/createSecurityMiddleware.ts` | Global Koa middleware factory (headers, CORS, rate limit, proxy trust) |
| `src/server/security/createSecurityMiddleware.tests.ts` | Tests for global middleware |
| `src/server/security/withSecurity.ts` | Per-route override Koa middleware factory |
| `src/server/security/withSecurity.tests.ts` | Tests for per-route override |
| `src/server/security/index.ts` | Barrel export for the `security/` module |

### `socket-api` — modified files
| Path | Change |
|---|---|
| `src/server/providers/koa/setupKoa.ts` | Accept `ResolvedSecurityConfig`; configure `bodyParser` size limit; apply `app.proxy`; mount global middleware |
| `src/server/startServer.ts` | Add `security?: SecurityConfig` to `ServerConfig`; resolve and pass to `setupKoa` |
| `src/server/index.ts` | Re-export `SecurityConfig`, `withSecurity` |

### `mxdb-sync` — modified/deleted files
| Path | Change |
|---|---|
| `src/server/auth/registerAuthInviteRoute.ts` | Replace `inviteRateLimiter.check()` calls with `withSecurity({ rateLimit: { maxRequests: 5, windowMs: 900_000 } })` router middleware |
| `src/server/auth/RateLimiter.ts` | **Deleted** |

---

## Task 1: SecurityConfig types, defaults, and merge utility

**Repo:** `socket-api`

**Files:**
- Create: `src/server/security/SecurityConfig.ts`
- Create: `src/server/security/SecurityConfig.tests.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `c:/code/personal/socket-api/src/server/security/SecurityConfig.tests.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveSecurityConfig, mergeSecurityConfig, SECURITY_DEFAULTS } from './SecurityConfig';

describe('resolveSecurityConfig', () => {
  it('returns defaults when called with no argument', () => {
    const result = resolveSecurityConfig();
    expect(result.rateLimit).toEqual(SECURITY_DEFAULTS.rateLimit);
    expect(result.cors).toBe(false);
    expect(result.maxBodySizeKb).toBe(512);
    expect(result.trustedProxyHops).toBe(1);
    expect(result.securityHeaders).toBe(true);
  });

  it('merges partial rateLimit over defaults', () => {
    const result = resolveSecurityConfig({ rateLimit: { maxRequests: 10 } });
    expect(result.rateLimit).toEqual({
      maxRequests: 10,
      windowMs: SECURITY_DEFAULTS.rateLimit.windowMs,
      message: SECURITY_DEFAULTS.rateLimit.message,
    });
  });

  it('disables rateLimit when set to false', () => {
    const result = resolveSecurityConfig({ rateLimit: false });
    expect(result.rateLimit).toBe(false);
  });

  it('merges partial cors over cors defaults', () => {
    const result = resolveSecurityConfig({ cors: { allowedOrigins: 'https://myapp.com' } });
    expect(result.cors).toMatchObject({
      allowedOrigins: 'https://myapp.com',
      allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAgeSeconds: 600,
    });
  });

  it('disables cors when set to false', () => {
    const result = resolveSecurityConfig({ cors: false });
    expect(result.cors).toBe(false);
  });

  it('overrides scalar fields', () => {
    const result = resolveSecurityConfig({ maxBodySizeKb: 1024, trustedProxyHops: 2, securityHeaders: false });
    expect(result.maxBodySizeKb).toBe(1024);
    expect(result.trustedProxyHops).toBe(2);
    expect(result.securityHeaders).toBe(false);
  });
});

describe('mergeSecurityConfig', () => {
  it('deep merges rateLimit — only maxRequests overridden', () => {
    const base = resolveSecurityConfig({ rateLimit: { maxRequests: 100, windowMs: 60_000, message: 'slow down' } });
    const result = mergeSecurityConfig(base, { rateLimit: { maxRequests: 10 } });
    expect(result.rateLimit).toEqual({ maxRequests: 10, windowMs: 60_000, message: 'slow down' });
  });

  it('disables rateLimit via per-route override', () => {
    const base = resolveSecurityConfig();
    const result = mergeSecurityConfig(base, { rateLimit: false });
    expect(result.rateLimit).toBe(false);
  });

  it('enables cors from false base', () => {
    const base = resolveSecurityConfig({ cors: false });
    const result = mergeSecurityConfig(base, { cors: { allowedOrigins: 'https://myapp.com' } });
    expect(result.cors).toMatchObject({ allowedOrigins: 'https://myapp.com' });
  });

  it('deep merges cors — only allowedOrigins overridden', () => {
    const base = resolveSecurityConfig({ cors: { allowedOrigins: 'https://a.com', maxAgeSeconds: 300 } });
    const result = mergeSecurityConfig(base, { cors: { allowedOrigins: 'https://b.com' } });
    expect((result.cors as any).allowedOrigins).toBe('https://b.com');
    expect((result.cors as any).maxAgeSeconds).toBe(300);
  });

  it('leaves unspecified override fields unchanged', () => {
    const base = resolveSecurityConfig({ maxBodySizeKb: 256 });
    const result = mergeSecurityConfig(base, { rateLimit: { maxRequests: 5 } });
    expect(result.maxBodySizeKb).toBe(256);
  });
});
```

- [ ] **Step 1.2: Run tests — expect failures**

```
pnpm --dir c:/code/personal/socket-api test src/server/security/SecurityConfig.tests.ts
```

Expected: `Cannot find module './SecurityConfig'`

- [ ] **Step 1.3: Implement SecurityConfig.ts**

Create `c:/code/personal/socket-api/src/server/security/SecurityConfig.ts`:

```ts
export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  message: string;
}

export interface CorsConfig {
  allowedOrigins: string | string[] | RegExp;
  allowedMethods: string[];
  allowedHeaders: string[];
  maxAgeSeconds: number;
}

export interface SecurityConfig {
  rateLimit?: Partial<RateLimitConfig> | false;
  cors?: Partial<Omit<CorsConfig, 'allowedOrigins'>> & Pick<Partial<CorsConfig>, 'allowedOrigins'> | false;
  maxBodySizeKb?: number;
  trustedProxyHops?: number;
  securityHeaders?: boolean;
}

export interface ResolvedSecurityConfig {
  rateLimit: RateLimitConfig | false;
  cors: CorsConfig | false;
  maxBodySizeKb: number;
  trustedProxyHops: number;
  securityHeaders: boolean;
}

const CORS_FIELD_DEFAULTS: Omit<CorsConfig, 'allowedOrigins'> = {
  allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAgeSeconds: 600,
};

export const SECURITY_DEFAULTS = {
  rateLimit: {
    maxRequests: 100,
    windowMs: 60_000,
    message: 'Too many requests',
  } satisfies RateLimitConfig,
  cors: false as false,
  maxBodySizeKb: 512,
  trustedProxyHops: 1,
  securityHeaders: true,
};

export function resolveSecurityConfig(config?: SecurityConfig): ResolvedSecurityConfig {
  const rateLimit: RateLimitConfig | false = config?.rateLimit === false
    ? false
    : config?.rateLimit != null
      ? { ...SECURITY_DEFAULTS.rateLimit, ...config.rateLimit }
      : { ...SECURITY_DEFAULTS.rateLimit };

  const cors: CorsConfig | false = config?.cors === false
    ? false
    : config?.cors != null
      ? { ...CORS_FIELD_DEFAULTS, allowedOrigins: '', ...config.cors } as CorsConfig
      : false;

  return {
    rateLimit,
    cors,
    maxBodySizeKb: config?.maxBodySizeKb ?? SECURITY_DEFAULTS.maxBodySizeKb,
    trustedProxyHops: config?.trustedProxyHops ?? SECURITY_DEFAULTS.trustedProxyHops,
    securityHeaders: config?.securityHeaders ?? SECURITY_DEFAULTS.securityHeaders,
  };
}

export function mergeSecurityConfig(base: ResolvedSecurityConfig, override: SecurityConfig): ResolvedSecurityConfig {
  const rateLimit: RateLimitConfig | false = override.rateLimit === false
    ? false
    : override.rateLimit != null
      ? { ...(base.rateLimit !== false ? base.rateLimit : SECURITY_DEFAULTS.rateLimit), ...override.rateLimit }
      : base.rateLimit;

  const cors: CorsConfig | false = override.cors === false
    ? false
    : override.cors != null
      ? {
        ...CORS_FIELD_DEFAULTS,
        ...(base.cors !== false ? base.cors : {}),
        ...override.cors,
      } as CorsConfig
      : base.cors;

  return {
    rateLimit,
    cors,
    maxBodySizeKb: override.maxBodySizeKb ?? base.maxBodySizeKb,
    trustedProxyHops: override.trustedProxyHops ?? base.trustedProxyHops,
    securityHeaders: override.securityHeaders ?? base.securityHeaders,
  };
}
```

- [ ] **Step 1.4: Run tests — expect pass**

```
pnpm --dir c:/code/personal/socket-api test src/server/security/SecurityConfig.tests.ts
```

Expected: all tests pass.

- [ ] **Step 1.5: Commit**

```
git -C c:/code/personal/socket-api add src/server/security/SecurityConfig.ts src/server/security/SecurityConfig.tests.ts
git -C c:/code/personal/socket-api commit -m "feat(security): add SecurityConfig types, defaults, and merge utility"
```

---

## Task 2: RateLimiter class in socket-api

**Repo:** `socket-api`

**Files:**
- Create: `src/server/security/RateLimiter.ts`
- Create: `src/server/security/RateLimiter.tests.ts`

- [ ] **Step 2.1: Write the failing tests**

Create `c:/code/personal/socket-api/src/server/security/RateLimiter.tests.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from './RateLimiter';

describe('RateLimiter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('allows requests under the limit', () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.check('1.2.3.4')).toBe(true);
  });

  it('blocks the request that exceeds the limit', () => {
    const limiter = new RateLimiter(3, 60_000);
    limiter.check('1.2.3.4');
    limiter.check('1.2.3.4');
    limiter.check('1.2.3.4');
    expect(limiter.check('1.2.3.4')).toBe(false);
  });

  it('does not affect other IPs', () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.check('1.2.3.4');
    limiter.check('1.2.3.4'); // blocked
    expect(limiter.check('5.6.7.8')).toBe(true);
  });

  it('resets after the window expires', () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.check('1.2.3.4');
    expect(limiter.check('1.2.3.4')).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(limiter.check('1.2.3.4')).toBe(true);
  });

  it('reset() clears the record for an IP', () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.check('1.2.3.4');
    expect(limiter.check('1.2.3.4')).toBe(false);
    limiter.reset('1.2.3.4');
    expect(limiter.check('1.2.3.4')).toBe(true);
  });

  it('supports a composite key via additionalKey', () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.check('1.2.3.4', 'route-a');
    expect(limiter.check('1.2.3.4', 'route-a')).toBe(false);
    expect(limiter.check('1.2.3.4', 'route-b')).toBe(true);
  });
});
```

- [ ] **Step 2.2: Run tests — expect failures**

```
pnpm --dir c:/code/personal/socket-api test src/server/security/RateLimiter.tests.ts
```

Expected: `Cannot find module './RateLimiter'`

- [ ] **Step 2.3: Implement RateLimiter.ts**

Create `c:/code/personal/socket-api/src/server/security/RateLimiter.ts`:

```ts
interface Entry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  constructor(maxAttempts = 100, windowMs = 60_000) {
    this.#maxAttempts = maxAttempts;
    this.#windowMs = windowMs;
  }

  #maxAttempts: number;
  #windowMs: number;
  #store = new Map<string, Entry>();

  check(ip: string, additionalKey?: string): boolean {
    this.#cleanup();
    const now = Date.now();
    const key = additionalKey != null ? `${ip}:${additionalKey}` : ip;
    let entry = this.#store.get(key);
    if (entry == null || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + this.#windowMs };
      this.#store.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.#maxAttempts;
  }

  reset(ip: string, additionalKey?: string): void {
    const key = additionalKey != null ? `${ip}:${additionalKey}` : ip;
    this.#store.delete(key);
  }

  #cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.#store) {
      if (now > entry.resetAt) this.#store.delete(key);
    }
  }
}
```

- [ ] **Step 2.4: Run tests — expect pass**

```
pnpm --dir c:/code/personal/socket-api test src/server/security/RateLimiter.tests.ts
```

Expected: all 6 tests pass.

- [ ] **Step 2.5: Commit**

```
git -C c:/code/personal/socket-api add src/server/security/RateLimiter.ts src/server/security/RateLimiter.tests.ts
git -C c:/code/personal/socket-api commit -m "feat(security): add RateLimiter class"
```

---

## Task 3: Global security middleware

**Repo:** `socket-api`

**Files:**
- Create: `src/server/security/createSecurityMiddleware.ts`
- Create: `src/server/security/createSecurityMiddleware.tests.ts`

- [ ] **Step 3.1: Write the failing tests**

Create `c:/code/personal/socket-api/src/server/security/createSecurityMiddleware.tests.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createSecurityMiddleware, getResolvedSecurity } from './createSecurityMiddleware';
import { resolveSecurityConfig } from './SecurityConfig';
import type Koa from 'koa';

function makeMockApp() {
  return { proxy: false } as unknown as Koa;
}

function makeMockCtx(overrides: Partial<{
  ip: string;
  method: string;
  headers: Record<string, string>;
  status: number;
  body: unknown;
}> = {}) {
  const headers: Record<string, string> = overrides.headers ?? {};
  const ctx = {
    ip: overrides.ip ?? '1.2.3.4',
    method: overrides.method ?? 'GET',
    get: (h: string) => headers[h.toLowerCase()] ?? '',
    set: vi.fn(),
    state: {} as Record<string, unknown>,
    status: overrides.status ?? 200,
    body: overrides.body ?? undefined,
  };
  return ctx as unknown as Koa.Context;
}

describe('createSecurityMiddleware', () => {
  describe('proxy trust', () => {
    it('sets app.proxy=true when trustedProxyHops > 0', () => {
      const app = makeMockApp();
      createSecurityMiddleware(resolveSecurityConfig({ trustedProxyHops: 1 }), app);
      expect(app.proxy).toBe(true);
    });

    it('leaves app.proxy false when trustedProxyHops is 0', () => {
      const app = makeMockApp();
      createSecurityMiddleware(resolveSecurityConfig({ trustedProxyHops: 0 }), app);
      expect(app.proxy).toBe(false);
    });
  });

  describe('security headers', () => {
    it('sets security headers when enabled', async () => {
      const app = makeMockApp();
      const mw = createSecurityMiddleware(resolveSecurityConfig({ securityHeaders: true }), app);
      const ctx = makeMockCtx();
      const next = vi.fn().mockResolvedValue(undefined);
      await mw(ctx, next);
      expect(ctx.set).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
      expect(ctx.set).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
      expect(ctx.set).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
      expect(ctx.set).toHaveBeenCalledWith('X-XSS-Protection', '0');
      expect(ctx.set).toHaveBeenCalledWith('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    });

    it('skips security headers when disabled', async () => {
      const app = makeMockApp();
      const mw = createSecurityMiddleware(resolveSecurityConfig({ securityHeaders: false }), app);
      const ctx = makeMockCtx();
      const next = vi.fn().mockResolvedValue(undefined);
      await mw(ctx, next);
      expect(ctx.set).not.toHaveBeenCalledWith('X-Frame-Options', expect.anything());
    });
  });

  describe('CORS', () => {
    it('returns 403 when origin is not allowed', async () => {
      const app = makeMockApp();
      const mw = createSecurityMiddleware(resolveSecurityConfig({
        cors: { allowedOrigins: 'https://allowed.com' },
        securityHeaders: false,
        rateLimit: false,
      }), app);
      const ctx = makeMockCtx({ headers: { origin: 'https://bad.com' } });
      const next = vi.fn();
      await mw(ctx, next);
      expect(ctx.status).toBe(403);
      expect((ctx.body as any).error).toBe('CORS: origin not allowed');
      expect(next).not.toHaveBeenCalled();
    });

    it('sets CORS headers when origin matches a string', async () => {
      const app = makeMockApp();
      const mw = createSecurityMiddleware(resolveSecurityConfig({
        cors: { allowedOrigins: 'https://allowed.com' },
        securityHeaders: false,
        rateLimit: false,
      }), app);
      const ctx = makeMockCtx({ headers: { origin: 'https://allowed.com' } });
      const next = vi.fn().mockResolvedValue(undefined);
      await mw(ctx, next);
      expect(ctx.set).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://allowed.com');
      expect(next).toHaveBeenCalled();
    });

    it('matches origin against array', async () => {
      const app = makeMockApp();
      const mw = createSecurityMiddleware(resolveSecurityConfig({
        cors: { allowedOrigins: ['https://a.com', 'https://b.com'] },
        securityHeaders: false,
        rateLimit: false,
      }), app);
      const ctx = makeMockCtx({ headers: { origin: 'https://b.com' } });
      const next = vi.fn().mockResolvedValue(undefined);
      await mw(ctx, next);
      expect(ctx.set).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://b.com');
    });

    it('matches origin against RegExp', async () => {
      const app = makeMockApp();
      const mw = createSecurityMiddleware(resolveSecurityConfig({
        cors: { allowedOrigins: /^https:\/\/.*\.myapp\.com$/ },
        securityHeaders: false,
        rateLimit: false,
      }), app);
      const ctx = makeMockCtx({ headers: { origin: 'https://sub.myapp.com' } });
      const next = vi.fn().mockResolvedValue(undefined);
      await mw(ctx, next);
      expect(ctx.set).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://sub.myapp.com');
    });

    it('handles OPTIONS preflight with 204', async () => {
      const app = makeMockApp();
      const mw = createSecurityMiddleware(resolveSecurityConfig({
        cors: { allowedOrigins: 'https://allowed.com' },
        securityHeaders: false,
        rateLimit: false,
      }), app);
      const ctx = makeMockCtx({ method: 'OPTIONS', headers: { origin: 'https://allowed.com' } });
      const next = vi.fn();
      await mw(ctx, next);
      expect(ctx.status).toBe(204);
      expect(next).not.toHaveBeenCalled();
    });

    it('skips CORS when no Origin header', async () => {
      const app = makeMockApp();
      const mw = createSecurityMiddleware(resolveSecurityConfig({
        cors: { allowedOrigins: 'https://allowed.com' },
        securityHeaders: false,
        rateLimit: false,
      }), app);
      const ctx = makeMockCtx(); // no origin header
      const next = vi.fn().mockResolvedValue(undefined);
      await mw(ctx, next);
      expect(ctx.set).not.toHaveBeenCalledWith('Access-Control-Allow-Origin', expect.anything());
      expect(next).toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    it('returns 429 after exceeding the limit', async () => {
      const app = makeMockApp();
      const mw = createSecurityMiddleware(resolveSecurityConfig({
        rateLimit: { maxRequests: 2, windowMs: 60_000 },
        securityHeaders: false,
      }), app);
      const next = vi.fn().mockResolvedValue(undefined);
      await mw(makeMockCtx({ ip: '9.9.9.9' }), next);
      await mw(makeMockCtx({ ip: '9.9.9.9' }), next);
      const ctx = makeMockCtx({ ip: '9.9.9.9' });
      await mw(ctx, next);
      expect(ctx.status).toBe(429);
      expect((ctx.body as any).error).toBeDefined();
    });

    it('skips rate limiting when disabled', async () => {
      const app = makeMockApp();
      const mw = createSecurityMiddleware(resolveSecurityConfig({
        rateLimit: false,
        securityHeaders: false,
      }), app);
      const next = vi.fn().mockResolvedValue(undefined);
      for (let i = 0; i < 200; i++) await mw(makeMockCtx({ ip: '8.8.8.8' }), next);
      expect(next).toHaveBeenCalledTimes(200);
    });
  });

  describe('ctx.state resolution', () => {
    it('stores resolved config on ctx.state for withSecurity to read', async () => {
      const app = makeMockApp();
      const config = resolveSecurityConfig({ securityHeaders: false, rateLimit: false });
      const mw = createSecurityMiddleware(config, app);
      const ctx = makeMockCtx();
      const next = vi.fn().mockResolvedValue(undefined);
      await mw(ctx, next);
      expect(getResolvedSecurity(ctx)).toEqual(config);
    });
  });
});
```

- [ ] **Step 3.2: Run tests — expect failures**

```
pnpm --dir c:/code/personal/socket-api test src/server/security/createSecurityMiddleware.tests.ts
```

Expected: `Cannot find module './createSecurityMiddleware'`

- [ ] **Step 3.3: Implement createSecurityMiddleware.ts**

Create `c:/code/personal/socket-api/src/server/security/createSecurityMiddleware.ts`:

```ts
import type Koa from 'koa';
import type { CorsConfig, ResolvedSecurityConfig } from './SecurityConfig';
import { RateLimiter } from './RateLimiter';

const SECURITY_STATE_KEY = Symbol('resolvedSecurity');

export function getResolvedSecurity(ctx: Koa.Context): ResolvedSecurityConfig | undefined {
  return (ctx.state as Record<symbol, ResolvedSecurityConfig>)[SECURITY_STATE_KEY];
}

export function setResolvedSecurity(ctx: Koa.Context, config: ResolvedSecurityConfig): void {
  (ctx.state as Record<symbol, ResolvedSecurityConfig>)[SECURITY_STATE_KEY] = config;
}

export function createSecurityMiddleware(config: ResolvedSecurityConfig, app: Koa): Koa.Middleware {
  if (config.trustedProxyHops > 0) app.proxy = true;

  const rateLimiter = config.rateLimit !== false
    ? new RateLimiter(config.rateLimit.maxRequests, config.rateLimit.windowMs)
    : null;

  return async (ctx, next) => {
    setResolvedSecurity(ctx, config);

    if (config.securityHeaders) {
      ctx.set('X-Frame-Options', 'DENY');
      ctx.set('X-Content-Type-Options', 'nosniff');
      ctx.set('Referrer-Policy', 'no-referrer');
      ctx.set('X-XSS-Protection', '0');
      ctx.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    if (config.cors !== false) {
      const origin = ctx.get('Origin');
      if (origin) {
        if (!isOriginAllowed(origin, config.cors.allowedOrigins)) {
          ctx.status = 403;
          ctx.body = { error: 'CORS: origin not allowed' };
          return;
        }
        ctx.set('Access-Control-Allow-Origin', origin);
        ctx.set('Vary', 'Origin');
        ctx.set('Access-Control-Allow-Methods', config.cors.allowedMethods.join(', '));
        ctx.set('Access-Control-Allow-Headers', config.cors.allowedHeaders.join(', '));
        ctx.set('Access-Control-Max-Age', String(config.cors.maxAgeSeconds));
        if (ctx.method === 'OPTIONS') {
          ctx.status = 204;
          return;
        }
      }
    }

    if (rateLimiter != null && !rateLimiter.check(ctx.ip)) {
      ctx.status = 429;
      ctx.body = { error: (config.rateLimit as NonNullable<typeof config.rateLimit>).message };
      return;
    }

    await next();
  };
}

function isOriginAllowed(origin: string, allowedOrigins: CorsConfig['allowedOrigins']): boolean {
  if (typeof allowedOrigins === 'string') return origin === allowedOrigins;
  if (allowedOrigins instanceof RegExp) return allowedOrigins.test(origin);
  return allowedOrigins.includes(origin);
}
```

- [ ] **Step 3.4: Run tests — expect pass**

```
pnpm --dir c:/code/personal/socket-api test src/server/security/createSecurityMiddleware.tests.ts
```

Expected: all tests pass.

- [ ] **Step 3.5: Commit**

```
git -C c:/code/personal/socket-api add src/server/security/createSecurityMiddleware.ts src/server/security/createSecurityMiddleware.tests.ts
git -C c:/code/personal/socket-api commit -m "feat(security): add global security middleware (headers, CORS, rate limit)"
```

---

## Task 4: `withSecurity` per-route override

**Repo:** `socket-api`

**Files:**
- Create: `src/server/security/withSecurity.ts`
- Create: `src/server/security/withSecurity.tests.ts`

- [ ] **Step 4.1: Write the failing tests**

Create `c:/code/personal/socket-api/src/server/security/withSecurity.tests.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withSecurity } from './withSecurity';
import { createSecurityMiddleware } from './createSecurityMiddleware';
import { resolveSecurityConfig } from './SecurityConfig';
import type Koa from 'koa';

function makeMockApp() {
  return { proxy: false } as unknown as Koa;
}

function makeMockCtx(ip = '1.2.3.4', contentLength?: number) {
  const ctx = {
    ip,
    method: 'GET',
    get: vi.fn((h: string) => h.toLowerCase() === 'content-length' && contentLength != null ? String(contentLength) : ''),
    set: vi.fn(),
    state: {} as Record<symbol, unknown>,
    status: 200,
    body: undefined as unknown,
    request: { length: contentLength ?? 0 },
  };
  return ctx as unknown as Koa.Context;
}

async function applyGlobalThenRoute(
  globalConfig: Parameters<typeof resolveSecurityConfig>[0],
  routeOverride: Parameters<typeof withSecurity>[0],
  ctx: Koa.Context,
) {
  const resolved = resolveSecurityConfig(globalConfig);
  const globalMw = createSecurityMiddleware(resolved, makeMockApp());
  const routeMw = withSecurity(routeOverride);
  const next = vi.fn().mockResolvedValue(undefined);
  // Run global middleware, then route middleware
  await globalMw(ctx, async () => {
    await routeMw(ctx, next);
  });
  return next;
}

describe('withSecurity', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe('rate limit override', () => {
    it('applies a tighter per-route rate limit', async () => {
      const next = vi.fn().mockResolvedValue(undefined);
      const routeMw = withSecurity({ rateLimit: { maxRequests: 2, windowMs: 60_000 } });
      const globalConfig = resolveSecurityConfig({ rateLimit: false, securityHeaders: false });
      const globalMw = createSecurityMiddleware(globalConfig, makeMockApp());

      for (let i = 0; i < 2; i++) {
        const ctx = makeMockCtx('10.0.0.1');
        await globalMw(ctx, async () => { await routeMw(ctx, next); });
      }

      const blockedCtx = makeMockCtx('10.0.0.1');
      await globalMw(blockedCtx, async () => { await routeMw(blockedCtx, next); });

      expect(blockedCtx.status).toBe(429);
    });

    it('deep merges rateLimit — inherits windowMs from global', async () => {
      // We verify that the per-route rate limiter uses default windowMs (60s) when only maxRequests is overridden
      const routeMw = withSecurity({ rateLimit: { maxRequests: 1 } });
      const globalConfig = resolveSecurityConfig({ rateLimit: false, securityHeaders: false });
      const globalMw = createSecurityMiddleware(globalConfig, makeMockApp());
      const next = vi.fn().mockResolvedValue(undefined);

      const ctx1 = makeMockCtx('11.0.0.1');
      await globalMw(ctx1, async () => { await routeMw(ctx1, next); });

      const ctx2 = makeMockCtx('11.0.0.1');
      await globalMw(ctx2, async () => { await routeMw(ctx2, next); });
      expect(ctx2.status).toBe(429);

      // After window expires the limit resets
      vi.advanceTimersByTime(60_001);
      const ctx3 = makeMockCtx('11.0.0.1');
      await globalMw(ctx3, async () => { await routeMw(ctx3, next); });
      expect(ctx3.status).toBe(200);
    });

    it('disabling per-route rate limit does not add extra blocking', async () => {
      const next = vi.fn().mockResolvedValue(undefined);
      const routeMw = withSecurity({ rateLimit: false });
      const globalConfig = resolveSecurityConfig({ rateLimit: false, securityHeaders: false });
      const globalMw = createSecurityMiddleware(globalConfig, makeMockApp());

      for (let i = 0; i < 200; i++) {
        const ctx = makeMockCtx('12.0.0.1');
        await globalMw(ctx, async () => { await routeMw(ctx, next); });
      }
      expect(next).toHaveBeenCalledTimes(200);
    });
  });

  describe('body size override', () => {
    it('rejects request exceeding the per-route body size limit', async () => {
      const next = vi.fn().mockResolvedValue(undefined);
      const routeMw = withSecurity({ maxBodySizeKb: 1 }); // 1 KB
      const globalConfig = resolveSecurityConfig({ rateLimit: false, securityHeaders: false, maxBodySizeKb: 512 });
      const globalMw = createSecurityMiddleware(globalConfig, makeMockApp());

      const ctx = makeMockCtx('13.0.0.1', 2048); // 2 KB
      await globalMw(ctx, async () => { await routeMw(ctx, next); });

      expect(ctx.status).toBe(413);
      expect((ctx.body as any).error).toBe('Request body too large');
      expect(next).not.toHaveBeenCalled();
    });

    it('allows request within the per-route body size limit', async () => {
      const next = vi.fn().mockResolvedValue(undefined);
      const routeMw = withSecurity({ maxBodySizeKb: 10 });
      const globalConfig = resolveSecurityConfig({ rateLimit: false, securityHeaders: false });
      const globalMw = createSecurityMiddleware(globalConfig, makeMockApp());

      const ctx = makeMockCtx('14.0.0.1', 5 * 1024); // 5 KB — within 10 KB limit
      await globalMw(ctx, async () => { await routeMw(ctx, next); });

      expect(next).toHaveBeenCalled();
    });

    it('does not check body size when maxBodySizeKb is not overridden', async () => {
      const next = vi.fn().mockResolvedValue(undefined);
      const routeMw = withSecurity({ rateLimit: false }); // no maxBodySizeKb
      const globalConfig = resolveSecurityConfig({ rateLimit: false, securityHeaders: false });
      const globalMw = createSecurityMiddleware(globalConfig, makeMockApp());

      const ctx = makeMockCtx('15.0.0.1', 999 * 1024);
      await globalMw(ctx, async () => { await routeMw(ctx, next); });

      expect(next).toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 4.2: Run tests — expect failures**

```
pnpm --dir c:/code/personal/socket-api test src/server/security/withSecurity.tests.ts
```

Expected: `Cannot find module './withSecurity'`

- [ ] **Step 4.3: Implement withSecurity.ts**

Create `c:/code/personal/socket-api/src/server/security/withSecurity.ts`:

```ts
import type Koa from 'koa';
import type { SecurityConfig } from './SecurityConfig';
import { mergeSecurityConfig, SECURITY_DEFAULTS } from './SecurityConfig';
import { RateLimiter } from './RateLimiter';
import { getResolvedSecurity, setResolvedSecurity } from './createSecurityMiddleware';

export function withSecurity(overrides: SecurityConfig): Koa.Middleware {
  // Eagerly build the per-route rate limiter if the override specifies one.
  // Uses the override values merged over SECURITY_DEFAULTS so windowMs/message
  // fall back to defaults when not specified in the override.
  const routeRateLimit = overrides.rateLimit === false
    ? null
    : overrides.rateLimit != null
      ? { ...SECURITY_DEFAULTS.rateLimit, ...overrides.rateLimit }
      : null; // null = no additional per-route rate limiter (global handles it)

  const routeRateLimiter = routeRateLimit != null
    ? new RateLimiter(routeRateLimit.maxRequests, routeRateLimit.windowMs)
    : null;

  const hasBodySizeOverride = overrides.maxBodySizeKb != null;

  return async (ctx, next) => {
    const base = getResolvedSecurity(ctx);
    if (base == null) {
      // Global middleware was not applied — should not happen in normal usage.
      await next();
      return;
    }

    const merged = mergeSecurityConfig(base, overrides);
    setResolvedSecurity(ctx, merged);

    if (routeRateLimiter != null && !routeRateLimiter.check(ctx.ip)) {
      ctx.status = 429;
      ctx.body = { error: routeRateLimit!.message };
      return;
    }

    if (hasBodySizeOverride) {
      const contentLength = ctx.request?.length ?? 0;
      if (contentLength > merged.maxBodySizeKb * 1024) {
        ctx.status = 413;
        ctx.body = { error: 'Request body too large' };
        return;
      }
    }

    await next();
  };
}
```

- [ ] **Step 4.4: Run tests — expect pass**

```
pnpm --dir c:/code/personal/socket-api test src/server/security/withSecurity.tests.ts
```

Expected: all tests pass.

- [ ] **Step 4.5: Commit**

```
git -C c:/code/personal/socket-api add src/server/security/withSecurity.ts src/server/security/withSecurity.tests.ts
git -C c:/code/personal/socket-api commit -m "feat(security): add withSecurity per-route override middleware"
```

---

## Task 5: Barrel, wire into setupKoa and startServer, update exports

**Repo:** `socket-api`

**Files:**
- Create: `src/server/security/index.ts`
- Modify: `src/server/providers/koa/setupKoa.ts`
- Modify: `src/server/startServer.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 5.1: Create the barrel export**

Create `c:/code/personal/socket-api/src/server/security/index.ts`:

```ts
export type { SecurityConfig, ResolvedSecurityConfig, RateLimitConfig, CorsConfig } from './SecurityConfig';
export { resolveSecurityConfig, mergeSecurityConfig, SECURITY_DEFAULTS } from './SecurityConfig';
export { createSecurityMiddleware, getResolvedSecurity, setResolvedSecurity } from './createSecurityMiddleware';
export { withSecurity } from './withSecurity';
export { RateLimiter } from './RateLimiter';
```

- [ ] **Step 5.2: Update setupKoa.ts to accept and apply security config**

Full replacement of `c:/code/personal/socket-api/src/server/providers/koa/setupKoa.ts`:

```ts
import type { IncomingMessage, ServerResponse } from 'http';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import { createRequestLogger } from '../logger';
import type { AnyHttpServer } from '../../internalModels';
import { wrap } from '../../async-context/socketApiContext';
import type { ConnectionRegistry } from '../connection';
import type { ResolvedSecurityConfig } from '../../security';
import { createSecurityMiddleware } from '../../security';

export { Koa };

export function setupKoa(server: AnyHttpServer, registry: ConnectionRegistry, security: ResolvedSecurityConfig): Koa {
  const app = new Koa();
  app.use(bodyParser({
    jsonLimit: `${security.maxBodySizeKb}kb`,
    formLimit: `${security.maxBodySizeKb}kb`,
  }));
  app.use(createRequestLogger());
  app.use(createSecurityMiddleware(security, app));

  const handler = app.callback();
  server.on(
    'request',
    wrap(
      (req: IncomingMessage, res: ServerResponse) => registry.fromRequest(req, res),
      (req: IncomingMessage, res: ServerResponse) => {
        handler(req, res);
      },
    ),
  );

  return app;
}
```

- [ ] **Step 5.3: Update startServer.ts to accept SecurityConfig and pass resolved config to setupKoa**

Open `c:/code/personal/socket-api/src/server/startServer.ts` and apply these changes:

Add to imports at top:
```ts
import type { SecurityConfig } from './security';
import { resolveSecurityConfig } from './security';
```

Add `security?: SecurityConfig;` to the `ServerConfig` interface (after `onRegisterRoutes`):
```ts
  onRegisterRoutes?(router: Router): PromiseMaybe<void>;
  security?: SecurityConfig;
```

In the `startServer` function body, replace the `setupKoa` call:
```ts
// Before:
const app = setupKoa(server, registry);

// After:
const app = setupKoa(server, registry, resolveSecurityConfig(config.security));
```

- [ ] **Step 5.4: Update src/server/index.ts to export the new security surface**

Open `c:/code/personal/socket-api/src/server/index.ts` and add:
```ts
export type { SecurityConfig, ResolvedSecurityConfig, RateLimitConfig, CorsConfig } from './security';
export { withSecurity } from './security';
```

The full file should now be:
```ts
import { createServerActionHandler, useAction, type SocketAPIServerAction } from './actions';
import { useEvent } from './events';
import { createServerSubscription, type SocketAPIServerSubscription } from './subscriptions';
import type { Server, Socket } from 'socket.io';

export { createServerActionHandler, useAction, useEvent, SocketAPIServerAction, createServerSubscription, SocketAPIServerSubscription };
export * from './startServer';
export * from '../common/models';
export { useSocketAPI } from './providers';
export type { Socket, Server };
export * from './async-context';
export type { SecurityConfig, ResolvedSecurityConfig, RateLimitConfig, CorsConfig } from './security';
export { withSecurity } from './security';
```

- [ ] **Step 5.5: Run the full test suite**

```
pnpm --dir c:/code/personal/socket-api test
```

Expected: all existing tests plus the new security tests pass. No TypeScript errors.

- [ ] **Step 5.6: Commit**

```
git -C c:/code/personal/socket-api add src/server/security/index.ts src/server/providers/koa/setupKoa.ts src/server/startServer.ts src/server/index.ts
git -C c:/code/personal/socket-api commit -m "feat(security): wire security middleware into setupKoa and export withSecurity"
```

---

## Task 6: mxdb-sync — update invite routes, delete old RateLimiter

**Repo:** `mxdb-sync`

**Files:**
- Modify: `src/server/auth/registerAuthInviteRoute.ts`
- Delete: `src/server/auth/RateLimiter.ts`

> **Note:** `mxdb-sync`'s `ServerConfig` already extends `socket-api`'s `StartSocketServerConfig`, and `startAuthenticatedServer` spreads `...config` into `startSocketServer`. Adding `security` to socket-api's `ServerConfig` (Task 5) means it flows through automatically — no changes to `internalModels.ts` or `startAuthenticatedServer.ts` are needed.

- [ ] **Step 6.1: Update registerAuthInviteRoute.ts**

Replace the file at `c:/code/personal/mxdb-sync/src/server/auth/registerAuthInviteRoute.ts`:

```ts
import type Router from 'koa-router';
import type { ParameterizedContext } from 'koa';
import type { MXDBInitialRegistrationResponse, MXDBRegistrationPayload, MXDBUserDetails } from '../../common/models';
import { ApiError, is } from '@anupheaus/common';
import type { ServerDb } from '../providers/db/ServerDb';
import { AuthCollection } from './AuthCollection';
import type { ULID } from 'ulidx';
import { decodeTime, ulid } from 'ulidx';
import { withSecurity } from '@anupheaus/nexus/server';

const INVITE_RATE_LIMIT = { maxRequests: 5, windowMs: 15 * 60 * 1000, message: 'Too many invite redemption attempts. Please wait before trying again.' };

function getRequestId(ctx: ParameterizedContext) {
  const requestId = ctx.query.requestId as string;
  if (!requestId) throw new ApiError({ message: 'Missing requestId' });
  return requestId;
}

async function findInviteByRequestId(authColl: AuthCollection, requestId: string) {
  const record = await authColl.findByRequestId(requestId);
  if (record == null) throw new ApiError({ message: 'Invite link not found.' });
  if (!record.isEnabled) throw new ApiError({ message: 'Invite link has already been used or disabled.' });
  return record;
}

function validateTTL(timestamp: ULID, inviteLinkTTLMs: number) {
  const createdAt = decodeTime(timestamp);
  if (Date.now() - createdAt > inviteLinkTTLMs) throw new ApiError({ message: 'Invite link has expired.' });
}

async function findInviteByRegistrationToken(authColl: AuthCollection, registrationToken: string) {
  const record = await authColl.findByRegistrationToken(registrationToken);
  if (record == null) throw new ApiError({ message: 'Invite link not found.' });
  if (!record.isEnabled) throw new ApiError({ message: 'Invite link has already been used or disabled.' });
  return record;
}

export function registerAuthInviteRoute(router: Router, name: string, db: ServerDb, inviteLinkTTLMs: number, onGetUserDetails: (userId: string) => Promise<MXDBUserDetails>) {
  const inviteSecurity = withSecurity({ rateLimit: INVITE_RATE_LIMIT });

  router.get(`/${name}/register`, inviteSecurity, async ctx => {
    const requestId = getRequestId(ctx);
    validateTTL(requestId, inviteLinkTTLMs);
    const authColl = new AuthCollection(db);
    const record = await findInviteByRequestId(authColl, requestId);
    await authColl.update(requestId, { isEnabled: false });
    const userDetails = await onGetUserDetails(record.userId);
    if (!userDetails) throw new ApiError({ message: 'User not found or not authorized to access this resource.' });
    const registrationToken = ulid();
    await authColl.update(requestId, { registrationToken, isEnabled: true });
    const response: MXDBInitialRegistrationResponse = { registrationToken, userDetails };
    ctx.body = response;
    ctx.status = 200;
  });

  router.post(`/${name}/register`, inviteSecurity, async ctx => {
    const payload = ctx.request.body as MXDBRegistrationPayload;
    if (!is.plainObject(payload)) throw new ApiError({ message: 'Invalid registration payload.' });
    const { registrationToken, deviceDetails, keyHash } = payload;
    if (is.empty(registrationToken)) throw new ApiError({ message: 'Missing registration token.' });
    if (is.empty(keyHash)) throw new ApiError({ message: 'Missing key hash.' });
    if (!is.plainObject(deviceDetails)) throw new ApiError({ message: 'Invalid device details.' });
    validateTTL(registrationToken, inviteLinkTTLMs);
    const authColl = new AuthCollection(db);
    const record = await findInviteByRegistrationToken(authColl, registrationToken);
    if (!record.isEnabled) throw new ApiError({ message: 'Invite link has already been used or disabled.' });
    const authenticationToken = ulid();
    await authColl.update(record.requestId, { keyHash, deviceDetails, pendingToken: authenticationToken });
    ctx.body = { token: authenticationToken };
    ctx.status = 200;
  });
}
```

- [ ] **Step 6.2: Delete RateLimiter.ts**

```
git -C c:/code/personal/mxdb-sync rm src/server/auth/RateLimiter.ts
```

- [ ] **Step 6.3: Check for any remaining imports of RateLimiter**

```
pnpm --dir c:/code/personal/mxdb-sync exec grep -r "RateLimiter\|inviteRateLimiter" src/
```

Expected: no output (all references gone).

- [ ] **Step 6.4: Run mxdb-sync unit tests**

```
pnpm --dir c:/code/personal/mxdb-sync test
```

Expected: all tests pass, no TypeScript errors, no missing module errors.

- [ ] **Step 6.5: Commit**

```
git -C c:/code/personal/mxdb-sync add src/server/auth/registerAuthInviteRoute.ts
git -C c:/code/personal/mxdb-sync commit -m "feat(security): replace inviteRateLimiter with withSecurity; delete RateLimiter.ts"
```

---

## Done

At this point:
- All HTTP requests to the Koa server pass through the global security middleware (security headers, CORS, rate limit, body size) before any handler runs
- Per-route tightening is available via `withSecurity(overrides)` from `@anupheaus/nexus/server`
- `mxdb-sync`'s invite routes use the unified rate limiter (5 req / 15 min)
- The bespoke `RateLimiter.ts` in `mxdb-sync` is gone
- Consumers who call `startServer()` get full protection with sensible defaults and zero config required
