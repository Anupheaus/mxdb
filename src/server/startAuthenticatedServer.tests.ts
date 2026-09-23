import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@anupheaus/common';
import type { Logger } from '@anupheaus/common';
import type { Socket } from 'socket.io';
import type { IncomingMessage } from 'http';
import type { NexusAuthRecord } from '@anupheaus/nexus/common';
import type { MXDBAccount, MXDBUser } from '../common/models';
import type { ServerDb, ConnectionDbPool } from './providers';
import type { ServerAuthConfig, ServerConfig } from './internalModels';

// ─── nexus boundary ───────────────────────────────────────────────────────────
// startAuthenticatedServer's job is to translate MXDB's server config into a nexus socket
// server config and to react to nexus's connection lifecycle. nexus is stubbed so each test
// can drive that lifecycle directly and observe what MXDB hands back to it.

interface SocketAuthCtx {
  user?: MXDBUser;
  account?: MXDBAccount;
  setUser: ReturnType<typeof vi.fn>;
  setAccount: ReturnType<typeof vi.fn>;
}

const nexus = vi.hoisted(() => ({
  socketServerConfig: undefined as any,
  socketAuthCtx: undefined as unknown as SocketAuthCtx,
  impersonatedUsers: [] as unknown[],
  emittedS2C: [] as unknown[],
}));

vi.mock('@anupheaus/nexus/server', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startServer: vi.fn(async (config: unknown) => {
    nexus.socketServerConfig = config;
    return { app: { isFakeApp: true }, startListening: vi.fn(), stopListening: vi.fn(), updateCertificate: vi.fn() };
  }),
  defineAuthentication: () => ({
    configureAuthentication: (config: unknown) => ({ configuredAuth: config }),
    useAuthentication: () => ({
      impersonateUser: async (user: unknown, delegate: () => Promise<void>) => {
        nexus.impersonatedUsers.push(user);
        await delegate();
      },
    }),
  }),
  useAction: () => async (payload: unknown) => { nexus.emittedS2C.push(payload); },
  useAuthentication: () => nexus.socketAuthCtx,
}));

// ─── db boundary ─────────────────────────────────────────────────────────────

const db = vi.hoisted(() => ({
  changeListeners: new Set<(event: unknown) => void>(),
  setDbCalls: [] as unknown[],
  s2cRegistrations: [] as unknown[],
}));

vi.mock('./providers', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useDb: () => ({
    onChange: (listener: (event: unknown) => void) => {
      db.changeListeners.add(listener);
      return () => db.changeListeners.delete(listener);
    },
  }),
  setDb: (serverDb: unknown) => { db.setDbCalls.push(serverDb); },
  setServerToClientSync: (s2c: unknown) => { db.s2cRegistrations.push(s2c); },
}));

vi.mock('./seeding', () => ({ seedCollections: vi.fn(async () => undefined) }));

const { startAuthenticatedServer, listConnectedClients } = await import('./startAuthenticatedServer');
const { WebAuthnAuthCollection } = await import('./auth/WebAuthnAuthCollection');
const { GoogleOAuthAuthCollection } = await import('./auth/GoogleOAuthAuthCollection');
const { ServerToClientSynchronisation } = await import('./ServerToClientSynchronisation');
const { seedCollections } = await import('./seeding');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  const logger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn(),
    createSubLogger: () => logger,
  };
  return logger as unknown as Logger;
}

const WEBAUTHN_AUTH: ServerAuthConfig = { mode: 'webauthn' };

const GOOGLE_AUTH: ServerAuthConfig = {
  mode: 'google-oauth',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://app.example/callback',
  baseScopes: ['email'],
  onCreateUser: vi.fn(),
};

type StartOptions = Partial<ServerConfig> & { dbPool?: ConnectionDbPool };

async function start(options: StartOptions = {}) {
  const result = await startAuthenticatedServer({
    name: 'my-app',
    collections: [],
    mongoDbUrl: 'mongodb://unused',
    mongoDbName: 'unused',
    logger: makeLogger(),
    auth: WEBAUTHN_AUTH,
    db: {} as ServerDb,
    dbPool: { getOrCreate: vi.fn() } as unknown as ConnectionDbPool,
    ...options,
  } as Parameters<typeof startAuthenticatedServer>[0]);
  return { ...result, socketServerConfig: nexus.socketServerConfig, configuredAuth: nexus.socketServerConfig.auth.configuredAuth };
}

let socketCounter = 0;

interface FakeSocketOptions {
  cookie?: string;
  sessionToken?: string;
}

function makeSocket({ cookie, sessionToken }: FakeSocketOptions = {}) {
  const onceHandlers = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    id: `socket-${++socketCounter}`,
    handshake: { headers: cookie == null ? {} : { cookie }, auth: sessionToken == null ? {} : { sessionToken } },
    emit: vi.fn(),
    once: (event: string, handler: (...args: unknown[]) => void) => { onceHandlers.set(event, handler); },
    /** Simulates socket.io's own `disconnect` event (which nexus follows with onClientDisconnected). */
    fireDisconnect: (reason: string) => onceHandlers.get('disconnect')?.(reason),
  };
  return socket as typeof socket & Socket;
}

function signInAs(user?: MXDBUser, account?: MXDBAccount): SocketAuthCtx {
  nexus.socketAuthCtx = {
    user,
    account,
    setUser: vi.fn(async () => undefined),
    setAccount: vi.fn(async (next: MXDBAccount) => { nexus.socketAuthCtx.account = next; }),
  };
  return nexus.socketAuthCtx;
}

async function disconnect(socketServerConfig: any, socket: ReturnType<typeof makeSocket>, reason = 'transport close') {
  socket.fireDisconnect(reason);
  await socketServerConfig.onClientDisconnected(socket);
}

function authRecord(overrides: Partial<NexusAuthRecord> & { accountId?: string } = {}): NexusAuthRecord {
  return { requestId: 'req-1', sessionToken: 'tok-1', userId: 'user-1', deviceId: 'device-1', isEnabled: true, ...overrides } as NexusAuthRecord;
}

const USER: MXDBUser = { id: 'user-1' } as MXDBUser;
const ACCOUNT: MXDBAccount = { id: 'account-1' } as MXDBAccount;

beforeEach(() => {
  nexus.impersonatedUsers.length = 0;
  nexus.emittedS2C.length = 0;
  db.setDbCalls.length = 0;
  db.s2cRegistrations.length = 0;
  signInAs(undefined);
  vi.mocked(seedCollections).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ─── Authentication configuration ─────────────────────────────────────────────

describe('startAuthenticatedServer — authentication configuration', () => {
  it('backs webauthn authentication with a WebAuthn auth store and returns that store', async () => {
    const { configuredAuth, authColl } = await start({ auth: WEBAUTHN_AUTH });

    expect(configuredAuth.mode).toBe('webauthn');
    expect(configuredAuth.store).toBeInstanceOf(WebAuthnAuthCollection);
    expect(authColl).toBe(configuredAuth.store);
  });

  it('backs google-oauth authentication with a Google auth store and passes the OAuth client settings through', async () => {
    const { configuredAuth } = await start({ auth: GOOGLE_AUTH });

    expect(configuredAuth).toEqual(expect.objectContaining({
      mode: 'google-oauth',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://app.example/callback',
      baseScopes: ['email'],
      onCreateUser: GOOGLE_AUTH.onCreateUser,
    }));
    expect(configuredAuth.store).toBeInstanceOf(GoogleOAuthAuthCollection);
  });

  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ])('google-oauth syncUserToClient=%s is passed to nexus as %s', async (syncUserToClient, expected) => {
    const { configuredAuth } = await start({ auth: { ...GOOGLE_AUTH, syncUserToClient } as ServerAuthConfig });
    expect(configuredAuth.syncUserToClient).toBe(expected);
  });

  describe('invite details (webauthn)', () => {
    it('refuses to issue invites when the host app has not supplied onGetInviteDetails', async () => {
      const { configuredAuth } = await start({ auth: { mode: 'webauthn' } });
      await expect(configuredAuth.onGetInviteDetails('user-1')).rejects.toThrow('onGetInviteDetails is required for WebAuthn servers');
    });

    it('delegates to the host app for invite details, forwarding user and account', async () => {
      const onGetInviteDetails = vi.fn(async (userId: string, accountId?: string) => ({ userId, accountId, name: 'Invitee' }));
      const { configuredAuth } = await start({ auth: { mode: 'webauthn', onGetInviteDetails } as unknown as ServerAuthConfig });

      await expect(configuredAuth.onGetInviteDetails('user-1', 'account-1')).resolves.toEqual({ userId: 'user-1', accountId: 'account-1', name: 'Invitee' });
    });
  });

  describe('user lookup', () => {
    it.each([WEBAUTHN_AUTH, GOOGLE_AUTH])('returns a bare { id } user when the host app has no onGetUserDetails ($mode)', async auth => {
      const { configuredAuth } = await start({ auth });
      await expect(configuredAuth.onGetUser('user-1')).resolves.toEqual({ id: 'user-1' });
    });

    it('returns the host app\'s user details', async () => {
      const onGetUserDetails = vi.fn(async (id: string) => ({ id, name: 'Alice' }) as MXDBUser);
      const { configuredAuth } = await start({ auth: { mode: 'webauthn', onGetUserDetails } });

      await expect(configuredAuth.onGetUser('user-1')).resolves.toEqual({ id: 'user-1', name: 'Alice' });
    });

    it('treats a failing host user lookup as an unknown user rather than an error', async () => {
      const onGetUserDetails = vi.fn(async () => { throw new Error('users service down'); });
      const { configuredAuth } = await start({ auth: { mode: 'webauthn', onGetUserDetails } });

      await expect(configuredAuth.onGetUser('user-1')).resolves.toBeUndefined();
    });
  });

  describe('per-connection database routing', () => {
    it('does not install connection resolvers when resolveConnectionDb is not configured', async () => {
      const { configuredAuth } = await start();
      expect([configuredAuth.onResolveConnection, configuredAuth.onResolveRestConnection]).toEqual([undefined, undefined]);
    });

    it('scopes a socket connection to the pooled db for the resolved tenant', async () => {
      const tenantDb = { tenant: 'acme' };
      const resolveConnectionDb = vi.fn(async () => ({ dbName: 'acme', mongoDbUrl: 'mongodb://acme' }));
      const dbPool = { getOrCreate: vi.fn(() => tenantDb) } as unknown as ConnectionDbPool;
      const { configuredAuth } = await start({ resolveConnectionDb, dbPool });

      await configuredAuth.onResolveConnection({ handshake: { headers: { host: 'acme.example' }, auth: {}, query: {} } });

      expect(resolveConnectionDb).toHaveBeenCalledWith({ headers: { host: 'acme.example' }, auth: {}, query: {} });
      expect(dbPool.getOrCreate).toHaveBeenCalledWith({ dbName: 'acme', mongoDbUrl: 'mongodb://acme' });
      expect(db.setDbCalls).toEqual([tenantDb]);
    });

    it('leaves a socket connection on the default db when the resolver returns null', async () => {
      const { configuredAuth } = await start({ resolveConnectionDb: vi.fn(async () => null) });

      await configuredAuth.onResolveConnection({ handshake: { headers: {} } });

      expect(db.setDbCalls).toEqual([]);
    });

    it('resolves REST requests from their host header and query string', async () => {
      const resolveConnectionDb = vi.fn(async () => null);
      const { configuredAuth } = await start({ resolveConnectionDb });
      const req = { url: '/my-app/webauthn/invite?account=acme&x=1', headers: { host: 'app.example' } } as unknown as IncomingMessage;

      await configuredAuth.onResolveRestConnection(req);

      expect(resolveConnectionDb).toHaveBeenCalledWith({ headers: { host: 'app.example' }, query: { account: 'acme', x: '1' } });
    });
  });
});

// ─── Server wiring ────────────────────────────────────────────────────────────

describe('startAuthenticatedServer — server wiring', () => {
  it('registers the host app\'s actions and subscriptions after MXDB\'s internal ones', async () => {
    const hostAction = { name: 'hostAction' };
    const hostSubscription = { name: 'hostSubscription' };
    const { socketServerConfig } = await start({ actions: [hostAction] as any, subscriptions: [hostSubscription] as any });

    expect(socketServerConfig.actions.length).toBeGreaterThan(1);
    expect(socketServerConfig.actions.at(-1)).toBe(hostAction);
    expect(socketServerConfig.subscriptions.length).toBeGreaterThan(1);
    expect(socketServerConfig.subscriptions.at(-1)).toBe(hostSubscription);
  });

  it('returns the nexus app and listener controls', async () => {
    const { app, startListening, stopListening, updateCertificate } = await start();
    expect(app).toEqual({ isFakeApp: true });
    expect([startListening, stopListening, updateCertificate].every(fn => typeof fn === 'function')).toBe(true);
  });

  describe('startup', () => {
    it.each([
      [true, 1],
      [false, 0],
      [undefined, 0],
    ])('with shouldSeedCollections=%s seeds collections %i time(s)', async (shouldSeedCollections, expectedSeeds) => {
      const { socketServerConfig } = await start({ shouldSeedCollections });
      await socketServerConfig.onStartup();
      expect(seedCollections).toHaveBeenCalledTimes(expectedSeeds);
    });

    it('runs startup work (including the host app\'s onStartup) as the admin user', async () => {
      const hostUsersDuringStartup: unknown[] = [];
      const onStartup = vi.fn(async () => { hostUsersDuringStartup.push(nexus.impersonatedUsers.at(-1)); });
      const { socketServerConfig } = await start({ onStartup });

      await socketServerConfig.onStartup();

      expect(nexus.impersonatedUsers).toEqual([{ id: Math.emptyId() }]);
      expect(onStartup).toHaveBeenCalledOnce();
      expect(hostUsersDuringStartup).toEqual([{ id: Math.emptyId() }]);
    });

    it('installs a no-op server-to-client sync before seeding so seeding never pushes to a client', async () => {
      const { socketServerConfig } = await start({ shouldSeedCollections: true });
      let s2cDuringSeed: unknown;
      vi.mocked(seedCollections).mockImplementationOnce(async () => { s2cDuringSeed = db.s2cRegistrations.at(-1); });

      await socketServerConfig.onStartup();

      expect((s2cDuringSeed as InstanceType<typeof ServerToClientSynchronisation>)?.isNoOp).toBe(true);
    });
  });

  describe('routes', () => {
    function makeRouter() {
      const routes: string[] = [];
      const register = (method: string) => (path: string) => { routes.push(`${method} ${path}`); };
      return { routes, router: { get: register('GET'), post: register('POST') } };
    }

    it.each(['development', 'test', undefined])('exposes the dev sign-in route when NODE_ENV=%s', async nodeEnv => {
      vi.stubEnv('NODE_ENV', nodeEnv as string);
      const { socketServerConfig } = await start();
      const { routes, router } = makeRouter();

      await socketServerConfig.onRegisterRoutes(router);

      expect(routes).toContain('POST /my-app/dev/signin');
    });

    it('never exposes the dev sign-in route in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const { socketServerConfig } = await start();
      const { routes, router } = makeRouter();

      await socketServerConfig.onRegisterRoutes(router);

      expect(routes.filter(route => route.includes('/dev/'))).toEqual([]);
    });

    it('exposes the MCP endpoint and then the host app\'s own routes', async () => {
      const onRegisterRoutes = vi.fn(async (router: any) => { router.get('/host-route'); });
      const { socketServerConfig } = await start({ onRegisterRoutes });
      const { routes, router } = makeRouter();

      await socketServerConfig.onRegisterRoutes(router);

      expect(routes).toEqual(expect.arrayContaining(['GET /mcp', 'POST /mcp']));
      expect(routes.at(-1)).toBe('GET /host-route');
    });
  });
});

// ─── Client connection lifecycle ──────────────────────────────────────────────

describe('startAuthenticatedServer — client connection', () => {
  it.each(['socketapi:authCheckComplete', 'nexus:authCheckComplete'])('tells an anonymous client the auth check is complete (%s)', async event => {
    const { socketServerConfig } = await start();
    const socket = makeSocket();

    await socketServerConfig.onClientConnected(socket);

    expect(socket.emit).toHaveBeenCalledWith(event);
  });

  it('does not report an anonymous client as a connected user', async () => {
    const onConnected = vi.fn();
    const { socketServerConfig } = await start({ onConnected });
    const socket = makeSocket();

    await socketServerConfig.onClientConnected(socket);

    expect(onConnected).not.toHaveBeenCalled();
    expect(listConnectedClients().find(({ socketId }) => socketId === socket.id)).toEqual({ socketId: socket.id, userId: undefined, accountId: undefined });
  });

  it('passes every connected socket to the host app\'s onClientConnected', async () => {
    const onClientConnected = vi.fn();
    const { socketServerConfig } = await start({ onClientConnected });
    const socket = makeSocket();

    await socketServerConfig.onClientConnected(socket);

    expect(onClientConnected).toHaveBeenCalledWith(socket);
  });

  it('confirms the signed-in user to the client and reports the connection with the account', async () => {
    const onConnected = vi.fn();
    const { socketServerConfig } = await start({ onConnected });
    const authCtx = signInAs(USER, ACCOUNT);
    const socket = makeSocket();

    await socketServerConfig.onClientConnected(socket);

    expect(authCtx.setUser).toHaveBeenCalledWith(USER);
    // Re-emitted on every connect: the client resets its account on each new socket.
    expect(authCtx.setAccount).toHaveBeenCalledWith(ACCOUNT);
    expect(onConnected).toHaveBeenCalledWith({ user: USER, account: ACCOUNT });
  });

  it('lists a signed-in client with its user and account ids', async () => {
    const { socketServerConfig } = await start();
    signInAs(USER, ACCOUNT);
    const socket = makeSocket();

    await socketServerConfig.onClientConnected(socket);

    expect(listConnectedClients()).toContainEqual({ socketId: socket.id, userId: 'user-1', accountId: 'account-1' });
  });

  it('registers the client for server-to-client sync before waiting on any auth lookup', async () => {
    const onGetAccountDetails = vi.fn(async () => ACCOUNT);
    const { socketServerConfig, authColl } = await start({ onGetAccountDetails });
    let releaseLookup!: (record: NexusAuthRecord) => void;
    vi.spyOn(authColl, 'findBySessionToken').mockReturnValue(new Promise(resolve => { releaseLookup = resolve; }));
    signInAs(USER);
    const socket = makeSocket({ cookie: 'socketapi_session=tok-1' });

    const connecting = socketServerConfig.onClientConnected(socket);
    await Promise.resolve();

    expect((db.s2cRegistrations.at(-1) as InstanceType<typeof ServerToClientSynchronisation>).isNoOp).toBe(false);
    expect(listConnectedClients().map(({ socketId }) => socketId)).toContain(socket.id);

    releaseLookup(authRecord({ accountId: 'account-1' }));
    await connecting;
  });

  describe('resolving the account for a signed-in user without one', () => {
    async function connectWithoutAccount({ socket, record, accountLookup }: {
      socket: ReturnType<typeof makeSocket>;
      record?: NexusAuthRecord;
      accountLookup?: (accountId: string) => Promise<MXDBAccount | undefined>;
    }) {
      const onConnected = vi.fn();
      const onGetAccountDetails = vi.fn(accountLookup ?? (async (accountId: string) => ({ id: accountId }) as MXDBAccount));
      const { socketServerConfig, authColl } = await start({ onConnected, onGetAccountDetails });
      const findBySessionToken = vi.spyOn(authColl, 'findBySessionToken').mockResolvedValue(record);
      const authCtx = signInAs(USER);
      await socketServerConfig.onClientConnected(socket);
      return { onConnected, onGetAccountDetails, findBySessionToken, authCtx };
    }

    it.each([
      ['nexus_session cookie', { cookie: 'nexus_session=tok-1' }],
      ['legacy socketapi_session cookie', { cookie: 'other=1; socketapi_session=tok-1' }],
      ['handshake auth sessionToken', { sessionToken: 'tok-1' }],
    ])('looks the session up from the %s', async (_label, socketOptions) => {
      const { findBySessionToken } = await connectWithoutAccount({ socket: makeSocket(socketOptions), record: authRecord({ accountId: 'account-1' }) });
      expect(findBySessionToken).toHaveBeenCalledWith('tok-1');
    });

    it('uses the account recorded against the session\'s auth record', async () => {
      const { onConnected, authCtx } = await connectWithoutAccount({
        socket: makeSocket({ cookie: 'nexus_session=tok-1' }),
        record: authRecord({ accountId: 'account-7' }),
      });

      expect(authCtx.setAccount).toHaveBeenCalledWith({ id: 'account-7' });
      expect(onConnected).toHaveBeenCalledWith({ user: USER, account: { id: 'account-7' } });
    });

    it.each([
      ['there is no session token', {}, authRecord({ accountId: 'account-1' })],
      ['the session has no auth record', { cookie: 'nexus_session=tok-1' }, undefined],
      ['the auth record has no account', { cookie: 'nexus_session=tok-1' }, authRecord()],
    ])('connects without an account when %s', async (_label, socketOptions, record) => {
      const { onConnected, onGetAccountDetails, authCtx } = await connectWithoutAccount({ socket: makeSocket(socketOptions), record });

      expect(onGetAccountDetails).not.toHaveBeenCalled();
      expect(authCtx.setAccount).not.toHaveBeenCalled();
      expect(onConnected).toHaveBeenCalledWith({ user: USER, account: undefined });
    });

    it.each([
      ['returns no account', async () => undefined],
      ['throws', async () => { throw new Error('accounts service down'); }],
    ])('connects without an account when the host account lookup %s', async (_label, accountLookup) => {
      const socket = makeSocket({ cookie: 'nexus_session=tok-1' });
      const { onConnected, authCtx } = await connectWithoutAccount({ socket, record: authRecord({ accountId: 'account-1' }), accountLookup });

      expect(authCtx.setAccount).not.toHaveBeenCalled();
      expect(onConnected).toHaveBeenCalledWith({ user: USER, account: undefined });
      expect(socket.emit).toHaveBeenCalledWith('nexus:authCheckComplete');
    });

    it('does not look up an account when the host app has no onGetAccountDetails', async () => {
      const { socketServerConfig, authColl } = await start();
      const findBySessionToken = vi.spyOn(authColl, 'findBySessionToken');
      signInAs(USER);

      await socketServerConfig.onClientConnected(makeSocket({ cookie: 'nexus_session=tok-1' }));

      expect(findBySessionToken).not.toHaveBeenCalled();
    });
  });
});

// ─── Client disconnection lifecycle ───────────────────────────────────────────

describe('startAuthenticatedServer — client disconnection', () => {
  it.each([
    ['server namespace disconnect', 'signedOut'],
    ['transport close', 'connectionLost'],
    ['ping timeout', 'connectionLost'],
    ['client namespace disconnect', 'connectionLost'],
  ])('reports a signed-in client disconnected with "%s" as %s', async (socketReason, reason) => {
    const onDisconnected = vi.fn();
    const { socketServerConfig } = await start({ onDisconnected });
    signInAs(USER, ACCOUNT);
    const socket = makeSocket();
    await socketServerConfig.onClientConnected(socket);

    await disconnect(socketServerConfig, socket, socketReason);

    expect(onDisconnected).toHaveBeenCalledWith({ user: USER, account: ACCOUNT, reason });
  });

  it('does not report an anonymous client\'s disconnection as a user disconnection', async () => {
    const onDisconnected = vi.fn();
    const onClientDisconnected = vi.fn();
    const { socketServerConfig } = await start({ onDisconnected, onClientDisconnected });
    const socket = makeSocket();
    await socketServerConfig.onClientConnected(socket);

    await disconnect(socketServerConfig, socket);

    expect(onDisconnected).not.toHaveBeenCalled();
    expect(onClientDisconnected).toHaveBeenCalledWith(socket);
  });

  it('removes the client from the connected clients list', async () => {
    const { socketServerConfig } = await start();
    signInAs(USER, ACCOUNT);
    const socket = makeSocket();
    await socketServerConfig.onClientConnected(socket);

    await disconnect(socketServerConfig, socket);

    expect(listConnectedClients().map(({ socketId }) => socketId)).not.toContain(socket.id);
  });

  it('stops forwarding database changes to a disconnected client', async () => {
    const { socketServerConfig } = await start();
    const socket = makeSocket();
    const listenersBefore = db.changeListeners.size;
    await socketServerConfig.onClientConnected(socket);
    expect(db.changeListeners.size).toBe(listenersBefore + 1);

    await disconnect(socketServerConfig, socket);

    expect(db.changeListeners.size).toBe(listenersBefore);
  });

  it('closes the client\'s server-to-client sync', async () => {
    const { socketServerConfig } = await start();
    const socket = makeSocket();
    await socketServerConfig.onClientConnected(socket);
    const s2c = db.s2cRegistrations.at(-1) as InstanceType<typeof ServerToClientSynchronisation>;
    const close = vi.spyOn(s2c, 'close');

    await disconnect(socketServerConfig, socket);

    expect(close).toHaveBeenCalledOnce();
  });

  it('treats a repeated disconnect notification for the same socket as a no-op', async () => {
    const onDisconnected = vi.fn();
    const { socketServerConfig } = await start({ onDisconnected });
    signInAs(USER);
    const socket = makeSocket();
    await socketServerConfig.onClientConnected(socket);

    await disconnect(socketServerConfig, socket);
    await socketServerConfig.onClientDisconnected(socket);

    expect(onDisconnected).toHaveBeenCalledOnce();
  });

  it('keeps connected/disconnected notifications balanced when a client drops while its account is still being resolved', async () => {
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    const { socketServerConfig, authColl } = await start({ onConnected, onDisconnected, onGetAccountDetails: async () => ACCOUNT });
    let releaseLookup!: (record: NexusAuthRecord) => void;
    vi.spyOn(authColl, 'findBySessionToken').mockReturnValue(new Promise(resolve => { releaseLookup = resolve; }));
    signInAs(USER);
    const socket = makeSocket({ cookie: 'nexus_session=tok-1' });

    const connecting = socketServerConfig.onClientConnected(socket);
    await disconnect(socketServerConfig, socket);
    releaseLookup(authRecord({ accountId: 'account-1' }));
    await connecting;

    // Host apps use these to track presence: a connect with no matching disconnect leaves the
    // user shown as online forever.
    expect(onConnected.mock.calls.length).toBe(onDisconnected.mock.calls.length);
  });

  it('reconnecting after a disconnect reports a fresh connection for the same user', async () => {
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    const { socketServerConfig } = await start({ onConnected, onDisconnected });
    signInAs(USER, ACCOUNT);
    const first = makeSocket();
    await socketServerConfig.onClientConnected(first);
    await disconnect(socketServerConfig, first);

    signInAs(USER, ACCOUNT);
    const second = makeSocket();
    await socketServerConfig.onClientConnected(second);

    expect(onConnected).toHaveBeenCalledTimes(2);
    expect(onDisconnected).toHaveBeenCalledOnce();
    expect(listConnectedClients()).toContainEqual({ socketId: second.id, userId: 'user-1', accountId: 'account-1' });
  });
});
