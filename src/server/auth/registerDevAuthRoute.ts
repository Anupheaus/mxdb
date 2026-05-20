import crypto from 'crypto';
import type Router from 'koa-router';
import type { WebAuthnAuthRecord, GoogleOAuthAuthRecord, NexusAuthRecord } from '@anupheaus/nexus/common';
import type { AuthCollection } from './AuthCollection';
import type { ServerAuthConfig } from '../internalModels';

const COOKIE_NAME = 'socketapi_session';
const DEV_SESSION_TOKEN_PREFIX = 'dev-bypass-';

function buildSetCookieHeader(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export function registerDevAuthRoute(
  router: Router,
  name: string,
  authColl: AuthCollection<NexusAuthRecord>,
  mode: ServerAuthConfig['mode'],
): void {
  router.post(`/${name}/dev/signin`, async ctx => {
    const body = ctx.request.body as Record<string, unknown>;
    const userId = body?.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
      ctx.status = 400;
      return;
    }
    const requestId = `dev-bypass-${userId}`;
    const sessionToken = `${DEV_SESSION_TOKEN_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
    const existing = await authColl.findById(requestId);

    if (existing != null) {
      await authColl.update(requestId, { sessionToken, isEnabled: true });
    } else if (mode === 'webauthn') {
      await authColl.create({
        requestId,
        userId,
        sessionToken,
        deviceId: 'dev-bypass',
        isEnabled: true,
        deviceDetails: undefined,
      } as WebAuthnAuthRecord);
    } else {
      await authColl.create({
        requestId,
        userId,
        sessionToken,
        deviceId: 'dev-bypass',
        isEnabled: true,
        deviceDetails: undefined,
        googleAccessToken: '',
        googleRefreshToken: '',
        googleTokenExpiresAt: 0,
        grantedScopes: [],
      } as GoogleOAuthAuthRecord);
    }

    ctx.set('Set-Cookie', buildSetCookieHeader(sessionToken));
    ctx.status = 200;
    ctx.body = { ok: true, userId, sessionToken };
  });
}
