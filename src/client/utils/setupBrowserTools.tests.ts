// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupBrowserTools } from './setupBrowserTools';

interface BrowserTools {
  listDatabases(): Promise<string[]>;
  setDevAuth?(userId: string): Promise<void>;
  clearDevAuth?(): void;
}

const tools = () => (window as unknown as { mxdb: BrowserTools }).mxdb;
const PENDING_DEV_AUTH_KEY = 'mxdb:dev-auth:my-app';

// ─── OPFS fake ────────────────────────────────────────────────────────────────

type FakeTree = { [name: string]: FakeTree | 'file' };

function makeDirectoryHandle(tree: FakeTree): unknown {
  return {
    kind: 'directory',
    async *entries() {
      for (const [name, node] of Object.entries(tree)) {
        yield [name, node === 'file' ? { kind: 'file' } : makeDirectoryHandle(node)];
      }
    },
  };
}

function installOpfs(tree: FakeTree | undefined) {
  const storage = tree == null ? undefined : { getDirectory: async () => makeDirectoryHandle(tree) };
  Object.defineProperty(navigator, 'storage', { value: storage, configurable: true });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  delete (window as unknown as { mxdb?: unknown }).mxdb;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  installOpfs(undefined);
});

describe('setupBrowserTools — dev auth', () => {
  it('signs in through the app\'s dev sign-in endpoint, sending cookies and the user id', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    setupBrowserTools('my-app');

    await tools().setDevAuth!('dev-user');

    expect(fetch).toHaveBeenCalledWith('/my-app/dev/signin', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'dev-user' }),
    });
  });

  it('records a pending dev sign-in for the app to pick up after reload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    setupBrowserTools('my-app');

    await tools().setDevAuth!('dev-user');

    expect(JSON.parse(localStorage.getItem(PENDING_DEV_AUTH_KEY)!)).toEqual({ userId: 'dev-user' });
  });

  it.each([400, 401, 404, 500])('fails with the status and records nothing when the server responds %i', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
    setupBrowserTools('my-app');

    await expect(tools().setDevAuth!('dev-user')).rejects.toThrow(`Dev auth failed: ${status}`);
    expect(localStorage.getItem(PENDING_DEV_AUTH_KEY)).toBeNull();
  });

  it('records nothing when the dev sign-in request cannot reach the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    setupBrowserTools('my-app');

    await expect(tools().setDevAuth!('dev-user')).rejects.toThrow('Failed to fetch');
    expect(localStorage.getItem(PENDING_DEV_AUTH_KEY)).toBeNull();
  });

  it('clearDevAuth removes a pending dev sign-in', () => {
    localStorage.setItem(PENDING_DEV_AUTH_KEY, JSON.stringify({ userId: 'dev-user' }));
    setupBrowserTools('my-app');

    tools().clearDevAuth!();

    expect(localStorage.getItem(PENDING_DEV_AUTH_KEY)).toBeNull();
  });

  it('does not expose any dev auth tools in production', () => {
    vi.stubEnv('NODE_ENV', 'production');

    setupBrowserTools('my-app');

    expect(Object.keys(tools())).toEqual(['listDatabases']);
  });
});

describe('setupBrowserTools — listDatabases', () => {
  it('fails clearly when the browser has no origin-private file system', async () => {
    installOpfs(undefined);
    setupBrowserTools('my-app');

    await expect(tools().listDatabases()).rejects.toThrow('OPFS is not available');
  });

  it('lists database files at any depth, sorted by path', async () => {
    installOpfs({
      'z.sqlite3': 'file',
      nested: { 'b.enc': 'file', deeper: { 'a.db': 'file' } },
      'a.sqlite': 'file',
    });
    setupBrowserTools('my-app');

    expect(await tools().listDatabases()).toEqual(['a.sqlite', 'nested/b.enc', 'nested/deeper/a.db', 'z.sqlite3']);
  });

  const databaseFileNames = ['x.enc', 'x.sqlite3', 'x.sqlite', 'x.db', 'x.sqlite3-wal', 'x.sqlite3-shm', 'x.sqlite-wal', 'x.sqlite-shm', 'x.db-wal', 'x.db-shm', 'X.SQLITE3'];
  const otherFileNames = ['x.txt', 'x.json', 'sqlite3', 'x.db.bak', 'x.encrypted', 'x'];

  it.each(databaseFileNames)('includes %s', async fileName => {
    installOpfs({ [fileName]: 'file' });
    setupBrowserTools('my-app');
    expect(await tools().listDatabases()).toEqual([fileName]);
  });

  it.each(otherFileNames)('excludes %s', async fileName => {
    installOpfs({ [fileName]: 'file' });
    setupBrowserTools('my-app');
    expect(await tools().listDatabases()).toEqual([]);
  });

  it('does not list directories whose names look like database files', async () => {
    installOpfs({ 'folder.db': {} });
    setupBrowserTools('my-app');
    expect(await tools().listDatabases()).toEqual([]);
  });
});
