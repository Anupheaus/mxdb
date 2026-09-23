import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Router from 'koa-router';
import type { NexusAuthRecord } from '@anupheaus/nexus/common';
import type { AuthCollection } from './AuthCollection';
import type { ServerAuthConfig } from '../internalModels';
import { registerDevAuthRoute } from './registerDevAuthRoute';

// ─── Fakes ──────────────────────────────────────────────────────────────────

type RouteHandler = (ctx: FakeContext) => Promise<void>;

interface FakeContext {
  request: { body: unknown };
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
  set(name: string, value: string): void;
}

function makeContext(body: unknown): FakeContext {
  const headers: Record<string, string> = {};
  return {
    request: { body },
    headers,
    set(name, value) { headers[name] = value; },
  };
}

/** In-memory auth store: just enough of AuthCollection for the dev route. */
function makeFakeAuthColl(seed: NexusAuthRecord[] = []) {
  const records = new Map(seed.map(record => [record.requestId, { ...record }]));
  const authColl = {
    findById: vi.fn(async (requestId: string) => records.get(requestId)),
    create: vi.fn(async (record: NexusAuthRecord) => { records.set(record.requestId, { ...record }); }),
    update: vi.fn(async (requestId: string, patch: Partial<NexusAuthRecord>) => {
      const existing = records.get(requestId);
      if (existing != null) records.set(requestId, { ...existing, ...patch });
    }),
  };
  return { authColl: authColl as unknown as AuthCollection<NexusAuthRecord>, records };
}

function registerAndGetHandler(authColl: AuthCollection<NexusAuthRecord>, mode: ServerAuthConfig['mode']) {
  const routes = new Map<string, RouteHandler>();
  const router = { post: (path: string, handler: RouteHandler) => { routes.set(path, handler); } } as unknown as Router;
  registerDevAuthRoute(router, 'my-app', authColl, mode);
  return routes;
}

async function signIn({ body, mode = 'webauthn', seed }: { body: unknown; mode?: ServerAuthConfig['mode']; seed?: NexusAuthRecord[] }) {
  const { authColl, records } = makeFakeAuthColl(seed);
  const handler = registerAndGetHandler(authColl, mode).get('/my-app/dev/signin')!;
  const ctx = makeContext(body);
  await handler(ctx);
  return { ctx, records, authColl };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('registerDevAuthRoute', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('registers a POST route scoped to the app name', () => {
    const { authColl } = makeFakeAuthColl();
    const routes = registerAndGetHandler(authColl, 'webauthn');
    expect([...routes.keys()]).toEqual(['/my-app/dev/signin']);
  });

  describe('rejects requests without a usable userId', () => {
    const invalidBodies: unknown[] = [
      undefined,
      null,
      {},
      { userId: '' },
      { userId: 123 },
      { userId: null },
      { userId: ['user-1'] },
      // NoSQL operator injection — must never reach the auth store as a query value
      { userId: { $gt: '' } },
      { userId: { $ne: null } },
    ];

    it.each(invalidBodies)('responds 400 for body %j', async body => {
      const { ctx } = await signIn({ body });
      expect(ctx.status).toBe(400);
    });

    it.each(invalidBodies)('does not touch the auth store for body %j', async body => {
      const { authColl } = await signIn({ body });
      expect(authColl.findById).not.toHaveBeenCalled();
      expect(authColl.create).not.toHaveBeenCalled();
      expect(authColl.update).not.toHaveBeenCalled();
    });

    it.each(invalidBodies)('does not set a session cookie for body %j', async body => {
      const { ctx } = await signIn({ body });
      expect(ctx.headers['Set-Cookie']).toBeUndefined();
    });
  });

  describe('first sign-in for a user', () => {
    it('creates an enabled webauthn dev-bypass record carrying the issued session token', async () => {
      const { ctx, records } = await signIn({ body: { userId: 'user-1' } });
      const { sessionToken } = ctx.body as { sessionToken: string };

      expect(records.get('dev-bypass-user-1')).toEqual({
        requestId: 'dev-bypass-user-1',
        userId: 'user-1',
        sessionToken,
        deviceId: 'dev-bypass',
        isEnabled: true,
        deviceDetails: undefined,
      });
    });

    it('creates a google-oauth shaped record with empty google tokens in google-oauth mode', async () => {
      const { ctx, records } = await signIn({ body: { userId: 'user-1' }, mode: 'google-oauth' });
      const { sessionToken } = ctx.body as { sessionToken: string };

      expect(records.get('dev-bypass-user-1')).toEqual({
        requestId: 'dev-bypass-user-1',
        userId: 'user-1',
        sessionToken,
        deviceId: 'dev-bypass',
        isEnabled: true,
        deviceDetails: undefined,
        googleAccessToken: '',
        googleRefreshToken: '',
        googleTokenExpiresAt: 0,
        grantedScopes: [],
      });
    });

    it('responds 200 with the user id and session token', async () => {
      const { ctx } = await signIn({ body: { userId: 'user-1' } });
      expect(ctx.status).toBe(200);
      expect(ctx.body).toEqual({ ok: true, userId: 'user-1', sessionToken: expect.stringMatching(/^dev-bypass-[A-Za-z0-9_-]{32}$/) });
    });

    it('sets an HttpOnly, SameSite=Strict session cookie holding the same token as the body', async () => {
      const { ctx } = await signIn({ body: { userId: 'user-1' } });
      const { sessionToken } = ctx.body as { sessionToken: string };
      expect(ctx.headers['Set-Cookie']).toBe(`socketapi_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`);
    });
  });

  describe('repeat sign-in for a user that already has a dev-bypass record', () => {
    const existing: NexusAuthRecord = {
      requestId: 'dev-bypass-user-1',
      userId: 'user-1',
      sessionToken: 'dev-bypass-old-token',
      deviceId: 'dev-bypass',
      isEnabled: false,
    };

    it('rotates the session token and re-enables the existing record instead of creating another', async () => {
      const { ctx, records, authColl } = await signIn({ body: { userId: 'user-1' }, seed: [existing] });
      const { sessionToken } = ctx.body as { sessionToken: string };

      expect(authColl.create).not.toHaveBeenCalled();
      expect(records.get('dev-bypass-user-1')).toEqual({ ...existing, sessionToken, isEnabled: true });
    });

    it('issues a different token from the previous one', async () => {
      const { ctx } = await signIn({ body: { userId: 'user-1' }, seed: [existing] });
      expect((ctx.body as { sessionToken: string }).sessionToken).not.toBe('dev-bypass-old-token');
    });
  });

  it('issues a unique session token on every sign-in', async () => {
    const { authColl } = makeFakeAuthColl();
    const handler = registerAndGetHandler(authColl, 'webauthn').get('/my-app/dev/signin')!;
    const tokens = new Set<string>();
    for (let attempt = 0; attempt < 20; attempt++) {
      const ctx = makeContext({ userId: 'user-1' });
      await handler(ctx);
      tokens.add((ctx.body as { sessionToken: string }).sessionToken);
    }
    expect(tokens.size).toBe(20);
  });

  it('keeps records for different users separate', async () => {
    const { authColl, records } = makeFakeAuthColl();
    const handler = registerAndGetHandler(authColl, 'webauthn').get('/my-app/dev/signin')!;
    await handler(makeContext({ userId: 'user-1' }));
    await handler(makeContext({ userId: 'user-2' }));
    expect([...records.values()].map(({ userId }) => userId).sort()).toEqual(['user-1', 'user-2']);
  });

  it('propagates auth store failures without setting a cookie', async () => {
    const { authColl } = makeFakeAuthColl();
    (authColl.findById as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('mongo down'));
    const handler = registerAndGetHandler(authColl, 'webauthn').get('/my-app/dev/signin')!;
    const ctx = makeContext({ userId: 'user-1' });

    await expect(handler(ctx)).rejects.toThrow('mongo down');
    expect(ctx.headers['Set-Cookie']).toBeUndefined();
  });
});
