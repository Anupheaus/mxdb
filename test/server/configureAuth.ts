import Router from 'koa-router';
import type Koa from 'koa';
import type { CreateInviteOptions } from '@anupheaus/nexus/server';

const TEST_USER_ID = 'test-user-1';

export function configureAuth(
  app: Koa,
  createInvite: ((options: CreateInviteOptions) => Promise<string>) | undefined,
): void {
  if (createInvite == null) return;

  const router = new Router();

  router.get('/api/create-invite', async ctx => {
    // Use http:// URL so the client's extractRequestId can parse the requestId
    // from the query param regardless of protocol.
    const url = await createInvite({ userId: TEST_USER_ID, baseUrl: `http://${ctx.host}` });
    ctx.body = { url };
  });

  app.use(router.routes());
  app.use(router.allowedMethods());
}
