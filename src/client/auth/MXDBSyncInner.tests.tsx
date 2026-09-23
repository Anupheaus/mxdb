// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act, useContext } from 'react';
import type { ReactNode, MutableRefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MXDBError } from '../../common';
import type { MXDBUser } from '../../common/models';

// ─── Boundaries ───────────────────────────────────────────────────────────────
// MXDBSyncInner decides WHEN the local encrypted database is opened, with WHICH name and key,
// and when it is torn down. The db/sync providers themselves (sqlite worker, sockets) are
// replaced with pass-throughs that record what they were mounted with.

interface DbsMount { name: string; encryptionKey: Uint8Array }

const harness = vi.hoisted(() => ({
  user: undefined as MXDBUser | undefined,
  signOut: (() => undefined) as () => void,
  dbsMounts: [] as DbsMount[],
  c2sOnUnauthorized: undefined as (() => void) | undefined,
}));

vi.mock('@anupheaus/nexus/client', () => ({
  useAuthentication: () => ({ user: harness.user, signOut: harness.signOut }),
}));

vi.mock('@anupheaus/react-ui', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createComponent: (_name: string, component: unknown) => component,
  useLogger: () => {
    const logger: Record<string, unknown> = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() };
    logger.createSubLogger = () => logger;
    return logger;
  },
}));

vi.mock('../providers/dbs', () => ({
  DbsProvider: ({ name, encryptionKey, children }: DbsMount & { children?: ReactNode }) => {
    harness.dbsMounts.push({ name, encryptionKey });
    return <div data-open-db={name}>{children}</div>;
  },
}));

vi.mock('../providers/client-to-server', () => ({
  ClientToServerSyncProvider: ({ onUnauthorized, children }: { onUnauthorized: () => void; children?: ReactNode }) => {
    harness.c2sOnUnauthorized = onUnauthorized;
    return children;
  },
  ClientToServerProvider: () => null,
}));

vi.mock('../providers/server-to-client', () => ({ ServerToClientProvider: () => null }));

const { MXDBSyncInner } = await import('./MXDBSyncInner');
const { MxdbReadyContext } = await import('./MxdbReadyContext');
const { deriveKey } = await import('./deriveKey');
const { saveEncryptionToSession, loadEncryptionFromSession } = await import('./encryptionSessionCache');

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Cross-tab BroadcastChannel fake ────────────────────────────────────────
// Delivers synchronously to every OTHER open channel with the same name, like the real API.

class FakeBroadcastChannel {
  static open = new Set<FakeBroadcastChannel>();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(public readonly name: string) { FakeBroadcastChannel.open.add(this); }
  postMessage(data: unknown) {
    for (const channel of FakeBroadcastChannel.open) {
      if (channel !== this && channel.name === this.name) channel.onmessage?.({ data });
    }
  }
  close() { FakeBroadcastChannel.open.delete(this); }
}

/** Another browser tab of the same app. */
function otherTab(appName = APP) { return new FakeBroadcastChannel(`mxdb-auth-${appName}`); }

// ─── Harness ─────────────────────────────────────────────────────────────────

const APP = 'my-app';
const ALICE: MXDBUser = { id: 'alice' } as MXDBUser;
const ZERO_KEY = new Uint8Array(32).fill(0);
const DEV_KEY = new Uint8Array(32).fill(0xde);

type PrfHandler = ((userId: string, prfOutput: ArrayBuffer, accountId?: string) => void | Promise<void>) | undefined;

interface RenderOptions {
  authMode?: 'webauthn' | 'google-oauth';
  onError?: (error: MXDBError) => void;
  onSignedIn?: (user: MXDBUser) => void;
  onSignedOut?: () => void;
}

let root: Root;
let container: HTMLElement;
let onPrfRef: MutableRefObject<PrfHandler>;
let readyContext: React.ContextType<typeof MxdbReadyContext>;
let renderOptions: RenderOptions;

function Probe() {
  readyContext = useContext(MxdbReadyContext);
  return <span data-testid="child">child</span>;
}

async function render(options: RenderOptions = renderOptions) {
  renderOptions = options;
  const { authMode = 'webauthn', onError, onSignedIn, onSignedOut } = options;
  await act(async () => {
    root.render(
      <MXDBSyncInner appName={APP} authMode={authMode} collections={[]} onPrfRef={onPrfRef} onError={onError} onSignedIn={onSignedIn} onSignedOut={onSignedOut}>
        <Probe />
      </MXDBSyncInner>,
    );
  });
}

async function setUser(user: MXDBUser | undefined) {
  harness.user = user;
  await render();
}

async function completePasskeyCeremony(userId: string, prfOutput: ArrayBuffer, accountId?: string) {
  await act(async () => { await onPrfRef.current?.(userId, prfOutput, accountId); });
}

const currentDb = () => harness.dbsMounts.at(-1);
const openDbName = () => container.querySelector('[data-open-db]')?.getAttribute('data-open-db') ?? undefined;
const bytes = (key: Uint8Array | undefined) => (key == null ? undefined : Array.from(key));
// A Node Buffer rather than `new Uint8Array().buffer`: under jsdom the latter is a jsdom-realm
// ArrayBuffer, which Node's WebCrypto (used by deriveKey) rejects.
const prfOutputFor = (seed: number) => Buffer.alloc(32, seed) as unknown as ArrayBuffer;

beforeEach(() => {
  harness.user = undefined;
  harness.signOut = vi.fn();
  harness.dbsMounts.length = 0;
  harness.c2sOnUnauthorized = undefined;
  FakeBroadcastChannel.open.clear();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  sessionStorage.clear();
  localStorage.clear();
  onPrfRef = { current: undefined };
  renderOptions = {};
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MXDBSyncInner — before sign-in', () => {
  it('renders its children without opening a local database', async () => {
    await render();

    expect(container.textContent).toBe('child');
    expect(harness.dbsMounts).toEqual([]);
  });

  it('reports the database as not ready', async () => {
    await render();
    expect(readyContext.getIsDbReady()).toBe(false);
  });

  it('resolves waitForDbReady with false if the database never becomes ready', async () => {
    vi.useFakeTimers();
    try {
      await render();
      const waiting = readyContext.waitForDbReady();
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(waiting).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MXDBSyncInner — google-oauth sign-in', () => {
  it('opens the user\'s database immediately, unencrypted (all-zero key)', async () => {
    await render({ authMode: 'google-oauth' });

    await setUser(ALICE);

    expect(currentDb()?.name).toBe('alice');
    expect(bytes(currentDb()?.encryptionKey)).toEqual(bytes(ZERO_KEY));
  });

  it('notifies the host app of the sign-in', async () => {
    const onSignedIn = vi.fn();
    await render({ authMode: 'google-oauth', onSignedIn });

    await setUser(ALICE);

    expect(onSignedIn).toHaveBeenCalledWith(ALICE);
  });

  it('marks the database ready and releases anyone already waiting for it', async () => {
    await render({ authMode: 'google-oauth' });
    const waiting = readyContext.waitForDbReady();

    await setUser(ALICE);

    await expect(waiting).resolves.toBe(true);
    expect(readyContext.getIsDbReady()).toBe(true);
  });

  it('does not install a passkey (PRF) handler', async () => {
    await render({ authMode: 'google-oauth' });
    expect(onPrfRef.current).toBeUndefined();
  });

  it('signs the user out when the server rejects sync as unauthorized', async () => {
    await render({ authMode: 'google-oauth' });
    await setUser(ALICE);

    harness.c2sOnUnauthorized?.();

    expect(harness.signOut).toHaveBeenCalledOnce();
  });
});

describe('MXDBSyncInner — webauthn sign-in', () => {
  it('waits for the passkey ceremony before opening a database when no key is cached', async () => {
    await render();

    await setUser(ALICE);

    expect(harness.dbsMounts).toEqual([]);
    expect(readyContext.getIsDbReady()).toBe(false);
  });

  it('opens the user\'s database with the key derived from the passkey PRF output', async () => {
    await render();
    await setUser(ALICE);

    await completePasskeyCeremony('alice', prfOutputFor(7));

    expect(currentDb()?.name).toBe('alice');
    expect(bytes(currentDb()?.encryptionKey)).toEqual(bytes(await deriveKey(prfOutputFor(7))));
  });

  it('opens the account\'s database when the passkey belongs to an account', async () => {
    await render();

    await completePasskeyCeremony('alice', prfOutputFor(7), 'acme');

    expect(currentDb()?.name).toBe('acme');
  });

  it('caches the derived key for this tab so a page refresh can skip the passkey ceremony', async () => {
    await render();

    await completePasskeyCeremony('alice', prfOutputFor(7), 'acme');

    const cached = loadEncryptionFromSession(APP, 'alice');
    expect(cached?.dbName).toBe('acme');
    expect(bytes(cached?.key)).toEqual(bytes(await deriveKey(prfOutputFor(7))));
  });

  it('restores the cached key on sign-in after a page refresh, without a passkey ceremony', async () => {
    const cachedKey = new Uint8Array(32).fill(42);
    saveEncryptionToSession(APP, 'alice', cachedKey, 'acme');
    await render();

    await setUser(ALICE);

    expect(currentDb()?.name).toBe('acme');
    expect(bytes(currentDb()?.encryptionKey)).toEqual(bytes(cachedKey));
  });

  it('does not use another user\'s cached key', async () => {
    saveEncryptionToSession(APP, 'bob', new Uint8Array(32).fill(42), 'bob');
    await render();

    await setUser(ALICE);

    expect(harness.dbsMounts).toEqual([]);
  });

  it('does not use a key cached by a different app', async () => {
    saveEncryptionToSession('other-app', 'alice', new Uint8Array(32).fill(42), 'alice');
    await render();

    await setUser(ALICE);

    expect(harness.dbsMounts).toEqual([]);
  });

  it('keeps the same key instance when the user arrives after the ceremony, so the database is not rebuilt mid-sync', async () => {
    await render();
    await completePasskeyCeremony('alice', prfOutputFor(7));
    const keyAfterCeremony = currentDb()?.encryptionKey;

    await setUser(ALICE); // restores the same bytes the PRF handler just cached

    expect(currentDb()?.encryptionKey).toBe(keyAfterCeremony);
  });

  it('switches to the new key when a later ceremony produces a different one', async () => {
    await render();
    await completePasskeyCeremony('alice', prfOutputFor(7));

    await completePasskeyCeremony('alice', prfOutputFor(8));

    expect(bytes(currentDb()?.encryptionKey)).toEqual(bytes(await deriveKey(prfOutputFor(8))));
  });

  it.each([
    ['a missing PRF output', undefined],
    ['a non-buffer PRF output', 'not-a-buffer'],
  ])('reports a fatal ENCRYPTION_FAILED error for %s and keeps the database closed', async (_label, prfOutput) => {
    const onError = vi.fn();
    await render({ onError });

    await completePasskeyCeremony('alice', prfOutput as unknown as ArrayBuffer);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'ENCRYPTION_FAILED', severity: 'fatal' }));
    expect(harness.dbsMounts).toEqual([]);
  });

  it('removes its passkey handler when unmounted so late ceremonies are ignored', async () => {
    await render();
    expect(onPrfRef.current).toBeTypeOf('function');

    await act(async () => { root.unmount(); });
    root = createRoot(container); // afterEach unmounts again

    expect(onPrfRef.current).toBeUndefined();
  });
});

describe('MXDBSyncInner — sign-out', () => {
  async function signedInWithWebAuthn() {
    const onSignedOut = vi.fn();
    await render({ onSignedOut });
    await setUser(ALICE);
    await completePasskeyCeremony('alice', prfOutputFor(7));
    return { onSignedOut };
  }

  it('closes the local database and reports it as not ready', async () => {
    await signedInWithWebAuthn();
    expect(openDbName()).toBe('alice');

    await setUser(undefined);

    expect(openDbName()).toBeUndefined();
    expect(readyContext.getIsDbReady()).toBe(false);
    expect(container.textContent).toBe('child');
  });

  it('forgets the cached encryption key so the next sign-in needs the passkey again', async () => {
    await signedInWithWebAuthn();

    await setUser(undefined);

    expect(loadEncryptionFromSession(APP, 'alice')).toBeUndefined();
  });

  it('notifies the host app of the sign-out', async () => {
    const { onSignedOut } = await signedInWithWebAuthn();

    await setUser(undefined);

    expect(onSignedOut).toHaveBeenCalledOnce();
  });

  it('tells the app\'s other tabs that this user signed out', async () => {
    await signedInWithWebAuthn();
    const tab = otherTab();
    const received: unknown[] = [];
    tab.onmessage = ({ data }) => received.push(data);

    await setUser(undefined);

    expect(received).toEqual([{ type: 'signed-out', userId: 'alice' }]);
  });

  it('does not report a sign-out when no one was signed in', async () => {
    const onSignedOut = vi.fn();
    await render({ onSignedOut });

    await setUser(undefined);

    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('closes the database when another tab signs the user out', async () => {
    await signedInWithWebAuthn();

    await act(async () => { otherTab().postMessage({ type: 'signed-out', userId: 'alice' }); });

    expect(openDbName()).toBeUndefined();
    expect(readyContext.getIsDbReady()).toBe(false);
    expect(loadEncryptionFromSession(APP, 'alice')).toBeUndefined();
  });

  it.each([
    ['another app', () => new FakeBroadcastChannel('mxdb-auth-other-app'), { type: 'signed-out', userId: 'alice' }],
    ['an unrelated message', () => otherTab(), { type: 'something-else' }],
    ['an empty message', () => otherTab(), null],
  ])('ignores cross-tab traffic from %s', async (_label, makeChannel, message) => {
    await signedInWithWebAuthn();

    await act(async () => { makeChannel().postMessage(message); });

    expect(readyContext.getIsDbReady()).toBe(true);
  });

  it('can sign in again after signing out', async () => {
    await signedInWithWebAuthn();
    await setUser(undefined);

    await setUser(ALICE);
    await completePasskeyCeremony('alice', prfOutputFor(9));

    expect(readyContext.getIsDbReady()).toBe(true);
    expect(bytes(currentDb()?.encryptionKey)).toEqual(bytes(await deriveKey(prfOutputFor(9))));
  });
});

describe('MXDBSyncInner — dev auth bypass', () => {
  const DEV_AUTH_KEY = `mxdb:dev-auth:${APP}`;

  it('opens the dev user\'s database with the dev key when a dev sign-in is pending', async () => {
    localStorage.setItem(DEV_AUTH_KEY, JSON.stringify({ userId: 'dev-user' }));

    await render();

    expect(currentDb()?.name).toBe('dev-user');
    expect(bytes(currentDb()?.encryptionKey)).toEqual(bytes(DEV_KEY));
  });

  it('consumes the pending dev sign-in so it only applies once', async () => {
    localStorage.setItem(DEV_AUTH_KEY, JSON.stringify({ userId: 'dev-user' }));

    await render();

    expect(localStorage.getItem(DEV_AUTH_KEY)).toBeNull();
  });

  it('discards a corrupt pending dev sign-in without opening a database', async () => {
    localStorage.setItem(DEV_AUTH_KEY, '{not json');

    await render();

    expect(localStorage.getItem(DEV_AUTH_KEY)).toBeNull();
    expect(harness.dbsMounts).toEqual([]);
  });

  it('ignores a pending dev sign-in for a different app', async () => {
    localStorage.setItem('mxdb:dev-auth:other-app', JSON.stringify({ userId: 'dev-user' }));

    await render();

    expect(harness.dbsMounts).toEqual([]);
  });

  it('never honours a dev sign-in in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    localStorage.setItem(DEV_AUTH_KEY, JSON.stringify({ userId: 'dev-user' }));

    await render();

    expect(harness.dbsMounts).toEqual([]);
    expect(localStorage.getItem(DEV_AUTH_KEY)).not.toBeNull();
  });
});
