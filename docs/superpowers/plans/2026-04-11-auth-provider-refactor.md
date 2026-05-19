# Auth Provider Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `IndexedDbBridge` with a layered provider chain — `IndexedDbProvider` → `AuthProvider` → `DbsProvider` → `TokenProvider` → `SocketProvider` — so each component has one clearly-bounded responsibility and the auth token never touches IndexedDB.

**Architecture:** `IndexedDbProvider` is a thin IDB CRUD wrapper. `AuthProvider` owns WebAuthn, the invite flow, and the encryption key lifecycle (signOut = clear key, not wipe IDB). `TokenProvider` reads/writes the socket auth token exclusively in SQLite and passes it to `SocketProvider` via props and a callback. `SocketProvider` wraps `SocketAPI` and handles token rotation internally.

**Tech Stack:** React 18, TypeScript, `@anupheaus/react-ui` (createComponent, useLogger), `@anupheaus/nexus/client` (SocketAPI, useEvent, useSocketAPI), vitest

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/client/auth/IndexedDbAuthStore.ts` | Strip `token`, `keyHash`, `updateDefaultToken` |
| New | `src/client/auth/IndexedDbContext.ts` | IDB CRUD context type + default |
| Rename+rewrite | `src/client/auth/IndexedDbBridge.tsx` → `IndexedDbProvider.tsx` | Thin IDB wrapper |
| New | `src/client/auth/AuthContext.ts` | Auth context type + default |
| New | `src/client/auth/AuthProvider.tsx` | WebAuthn, registration, encryption key, composes DbsProvider chain |
| New | `src/client/auth/TokenProvider.tsx` | Reads/writes SQLite token, passes to SocketProvider |
| New | `src/client/auth/SocketProvider.tsx` | SocketAPI + token rotation (replaces TokenRotationProvider wiring) |
| Modify | `src/client/MXDBSync.tsx` | Use IndexedDbProvider + AuthProvider |
| Modify | `src/client/hooks/useMXDBInvite.ts` | Thin hook delegating to AuthContext.register |
| Modify | `src/client/hooks/useMXDBSignOut.ts` | Use AuthContext.signOut |
| Modify | `src/client/hooks/useMXDBAuth.ts` | Use AuthContext.isAuthenticated |
| Delete | `src/client/auth/AuthTokenContext.ts` | Replaced by IndexedDbContext + AuthContext |
| Delete | `src/client/auth/SqliteTokenSync.tsx` | Replaced by TokenProvider |
| Delete | `src/client/auth/TokenRotationProvider.tsx` | Replaced by SocketProvider internals |

---

## Task 1: Strip token/keyHash from IndexedDbAuthStore

**Files:**
- Modify: `src/client/auth/IndexedDbAuthStore.ts`

- [ ] **Step 1: Update `MXDBAuthEntry` and remove `updateDefaultToken`**

Replace the entire file with:

```typescript
/**
 * §4.3 / §4.4 — IndexedDB auth store.
 *
 * Stores one record per registered device:
 *   { id, credentialId, dbName, isDefault }
 *
 * `dbName`       — random filename used for this user's SQLite DB in OPFS.
 * `credentialId` — raw WebAuthn credential ID bytes (for PRF key derivation).
 * `isDefault`    — true for the user that should be loaded on next app start.
 *
 * The auth token and keyHash are stored exclusively in the encrypted SQLite DB,
 * never in IndexedDB.
 */

const IDB_STORE = 'mxdb_authentication';

export interface MXDBAuthEntry {
  id: string;
  credentialId: Uint8Array;
  /** Random filename for this user's SQLite DB (no extension). */
  dbName: string;
  isDefault: boolean;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openIdb(appName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(appName, 1);
    req.onupgradeneeded = () =>
      req.result.createObjectStore(IDB_STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ─── IndexedDbAuthStore ───────────────────────────────────────────────────────

export class IndexedDbAuthStore {
  /** Returns the entry with `isDefault: true`, or `undefined`. */
  static async getDefault(appName: string): Promise<MXDBAuthEntry | undefined> {
    if (!isIndexedDbAvailable()) return undefined;
    const db = await openIdb(appName);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => { db.close(); resolve((req.result as MXDBAuthEntry[]).find(e => e.isDefault)); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }

  /** Returns all entries (for user-switching UI). */
  static async getAll(appName: string): Promise<MXDBAuthEntry[]> {
    if (!isIndexedDbAvailable()) return [];
    const db = await openIdb(appName);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => { db.close(); resolve(req.result as MXDBAuthEntry[]); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }

  /**
   * Saves a new entry as the default, clearing `isDefault` on all others.
   */
  static async save(appName: string, entry: MXDBAuthEntry): Promise<void> {
    if (!isIndexedDbAvailable()) return;
    const db = await openIdb(appName);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const getAllReq = store.getAll();
      getAllReq.onsuccess = () => {
        for (const existing of getAllReq.result as MXDBAuthEntry[]) {
          if (existing.isDefault) store.put({ ...existing, isDefault: false });
        }
        store.put({ ...entry, isDefault: true });
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  /** Clears `isDefault` on all entries (sign-out). */
  static async clearAllDefaults(appName: string): Promise<void> {
    if (!isIndexedDbAvailable()) return;
    const db = await openIdb(appName);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const getAllReq = store.getAll();
      getAllReq.onsuccess = () => {
        for (const entry of getAllReq.result as MXDBAuthEntry[]) {
          if (entry.isDefault) store.put({ ...entry, isDefault: false });
        }
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles (expect errors in other files — that's fine for now)**

```bash
cd c:/code/personal/mxdb && npx tsc --noEmit 2>&1 | head -40
```

Expected: errors referencing `token`, `keyHash`, `updateDefaultToken` in other files. That confirms the right fields were removed.

- [ ] **Step 3: Commit**

```bash
git -C c:/code/personal/mxdb add src/client/auth/IndexedDbAuthStore.ts
git -C c:/code/personal/mxdb commit -m "refactor: strip token/keyHash from MXDBAuthEntry and remove updateDefaultToken"
```

---

## Task 2: Create IndexedDbContext and IndexedDbProvider

**Files:**
- Create: `src/client/auth/IndexedDbContext.ts`
- Create: `src/client/auth/IndexedDbProvider.tsx`
- Delete: `src/client/auth/IndexedDbBridge.tsx` (at end of step)

- [ ] **Step 1: Create `IndexedDbContext.ts`**

```typescript
// src/client/auth/IndexedDbContext.ts
import { createContext } from 'react';
import type { MXDBAuthEntry } from './IndexedDbAuthStore';

export interface IndexedDbContextValue {
  getDefault(): Promise<MXDBAuthEntry | undefined>;
  saveEntry(entry: MXDBAuthEntry): Promise<void>;
  clearDefault(): Promise<void>;
}

export const IndexedDbContext = createContext<IndexedDbContextValue>({
  getDefault: async () => undefined,
  saveEntry: async () => void 0,
  clearDefault: async () => void 0,
});
```

- [ ] **Step 2: Create `IndexedDbProvider.tsx`**

```typescript
// src/client/auth/IndexedDbProvider.tsx
/**
 * Thin React wrapper over the IDB mxdb_authentication store.
 * Provides IndexedDbContext — CRUD only, no business logic.
 */
import { createComponent } from '@anupheaus/react-ui';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { IndexedDbAuthStore, isIndexedDbAvailable } from './IndexedDbAuthStore';
import { IndexedDbContext } from './IndexedDbContext';

interface Props {
  appName: string;
  children?: ReactNode;
}

export const IndexedDbProvider = createComponent('IndexedDbProvider', ({ appName, children }: Props) => {
  const value = useMemo(() => ({
    getDefault: () => isIndexedDbAvailable()
      ? IndexedDbAuthStore.getDefault(appName)
      : Promise.resolve(undefined),
    saveEntry: (entry: Parameters<typeof IndexedDbAuthStore.save>[1]) =>
      IndexedDbAuthStore.save(appName, entry),
    clearDefault: () => IndexedDbAuthStore.clearAllDefaults(appName),
  }), [appName]);

  return (
    <IndexedDbContext.Provider value={value}>
      {children}
    </IndexedDbContext.Provider>
  );
});
```

- [ ] **Step 3: Commit (keep IndexedDbBridge.tsx for now — it will be deleted in Task 9)**

```bash
git -C c:/code/personal/mxdb add src/client/auth/IndexedDbContext.ts src/client/auth/IndexedDbProvider.tsx
git -C c:/code/personal/mxdb commit -m "feat: add IndexedDbContext and thin IndexedDbProvider"
```

---

## Task 3: Create AuthContext

**Files:**
- Create: `src/client/auth/AuthContext.ts`

- [ ] **Step 1: Create `AuthContext.ts`**

```typescript
// src/client/auth/AuthContext.ts
import { createContext } from 'react';
import type { MXDBUserDetails } from '../../common/models';

export interface RegisterOptions {
  deviceDetails?: unknown;
  appName?: string;
}

export interface AuthContextValue {
  /** True once WebAuthn has produced an encryption key for the stored credential. */
  isAuthenticated: boolean;
  /**
   * Clears the in-memory encryption key — unmounts DbsProvider, TokenProvider,
   * and SocketProvider. IDB entry is preserved so the user can re-authenticate
   * via WebAuthn on next visit without going through the invite flow again.
   */
  signOut(): void;
  /**
   * Full invite registration flow: HTTP handshake → WebAuthn credential creation
   * → key derivation → server token retrieval → IDB save.
   */
  register(url: string, options?: RegisterOptions): Promise<{ userDetails: MXDBUserDetails }>;
}

export const AuthContext = createContext<AuthContextValue>({
  isAuthenticated: false,
  signOut: () => void 0,
  register: async () => { throw new Error('AuthProvider not mounted'); },
});
```

- [ ] **Step 2: Commit**

```bash
git -C c:/code/personal/mxdb add src/client/auth/AuthContext.ts
git -C c:/code/personal/mxdb commit -m "feat: add AuthContext"
```

---

## Task 4: Create AuthProvider

**Files:**
- Create: `src/client/auth/AuthProvider.tsx`

This component owns: WebAuthn assertion on mount, the full registration flow (moved from `useMXDBInvite`), sign-out (clear encryption key), BroadcastChannel for cross-tab sign-out, and composing `DbsProvider → TokenProvider` when authenticated.

- [ ] **Step 1: Create `AuthProvider.tsx`**

```typescript
// src/client/auth/AuthProvider.tsx
/**
 * Owns the authentication lifecycle:
 *  - On mount: reads default IDB entry → WebAuthn PRF assertion → encryptionKey
 *  - Authenticated: renders DbsProvider → TokenProvider → children
 *  - Unauthenticated: renders children directly
 *  - signOut(): clears encryptionKey (unmounts everything below), preserves IDB
 *  - register(url): full invite flow, stores pendingAuth for TokenProvider
 */
import { createComponent, useLogger } from '@anupheaus/react-ui';
import type { ReactNode } from 'react';
import { useState, useEffect, useCallback, useContext, useMemo, useRef } from 'react';
import { ulid } from 'ulidx';
import { AuthContext } from './AuthContext';
import type { RegisterOptions } from './AuthContext';
import { IndexedDbContext } from './IndexedDbContext';
import { deriveEncryptionKey, deriveKeyFromPrfOutput, PRF_SALT } from './deriveEncryptionKey';
import { DbsProvider } from '../providers/dbs';
import { TokenProvider } from './TokenProvider';
import type { MXDBCollection, MXDBError } from '../../common';
import type { MXDBUserDetails, MXDBInitialRegistrationResponse } from '../../common/models';

// ─── Registration helpers (module-level, no React) ───────────────────────────

function extractRequestId(url: string): string | undefined {
  try { return new URL(url).searchParams.get('requestId') ?? undefined; }
  catch { return undefined; }
}

function generateDbName(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function computeKeyHash(keyBytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(keyBytes).buffer);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function collectDeviceDetails(): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  if (typeof navigator !== 'undefined') {
    details.userAgent = navigator.userAgent;
    details.language = navigator.language;
    if ('platform' in navigator) details.platform = (navigator as any).platform;
    if ('vendor' in navigator) details.vendor = (navigator as any).vendor;
  }
  if (typeof screen !== 'undefined') {
    details.screenWidth = screen.width;
    details.screenHeight = screen.height;
    details.colorDepth = screen.colorDepth;
  }
  return details;
}

async function createWebAuthnCredential(
  userDetails: MXDBUserDetails,
  appName: string | undefined,
): Promise<{ credentialId: Uint8Array; prfOutput: ArrayBuffer }> {
  if (typeof navigator === 'undefined' || navigator.credentials == null)
    throw new Error('WebAuthn not supported.');
  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'app';
  const rpName = appName ?? (typeof document !== 'undefined' && document.title ? document.title : hostname);
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: rpName },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: userDetails.name,
        displayName: userDetails.displayName ?? userDetails.name,
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 60_000,
      attestation: 'none',
      extensions: { prf: { eval: { first: PRF_SALT } } } as any,
    },
  }) as PublicKeyCredential | null;
  if (credential == null) throw new Error('WebAuthn credential creation returned no credential.');
  const credentialId = new Uint8Array(credential.rawId);
  const prfOutput = (credential.getClientExtensionResults() as any)?.prf?.results?.first as ArrayBuffer | undefined;
  if (prfOutput == null) throw new Error('PRF output not supported.');
  return { credentialId, prfOutput };
}

async function fetchInitialRegistration(
  name: string,
  requestId: string,
): Promise<MXDBInitialRegistrationResponse> {
  const response = await fetch(`/${name}/register?requestId=${requestId}`, { method: 'GET' });
  const result = await response.json();
  if (typeof result !== 'object' || result == null) throw new Error('Invalid response from server.');
  if (typeof result.registrationToken !== 'string') throw new Error('Missing registration token.');
  if (typeof result.userDetails !== 'object') throw new Error('Missing user details.');
  return result as MXDBInitialRegistrationResponse;
}

async function fetchCompleteRegistration(
  name: string,
  registrationToken: string,
  keyHash: string,
  deviceDetails: unknown,
): Promise<string> {
  const response = await fetch(`/${name}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ registrationToken, keyHash, deviceDetails }),
  });
  const result = await response.json();
  if (typeof result !== 'object' || result == null) throw new Error('Invalid response from server.');
  if (typeof result.token !== 'string') throw new Error('Missing token.');
  return result.token as string;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  appName: string;
  host?: string;
  collections: MXDBCollection[];
  onError?(error: MXDBError): void;
  children?: ReactNode;
}

export const AuthProvider = createComponent('AuthProvider', ({
  appName,
  host,
  collections,
  onError,
  children,
}: Props) => {
  const logger = useLogger('Auth');
  const dbsLogger = useLogger('Dbs');
  const { getDefault, saveEntry } = useContext(IndexedDbContext);
  const [encryptionKey, setEncryptionKey] = useState<Uint8Array | undefined>();
  const [dbName, setDbName] = useState<string | undefined>();
  const [pendingAuth, setPendingAuth] = useState<{ token: string; keyHash: string } | undefined>();
  const [loaded, setLoaded] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);

  // ── Bootstrap: read IDB → WebAuthn → derive key ──────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const entry = await getDefault();
        if (entry != null) {
          logger.info('IDB entry found, deriving encryption key via WebAuthn');
          const key = await deriveEncryptionKey(entry.credentialId);
          setDbName(entry.dbName);
          setEncryptionKey(key);
        }
      } catch (err) {
        logger.error('Failed to derive encryption key', { error: err });
        onError?.({
          code: 'ENCRYPTION_FAILED',
          message: err instanceof Error ? err.message : 'Failed to derive encryption key',
          severity: 'fatal',
          originalError: err,
        });
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  // ── BroadcastChannel: cross-tab sign-out ─────────────────────────────────
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(`mxdb-auth-${appName}`);
    channelRef.current = channel;
    channel.onmessage = ({ data }: MessageEvent<{ type: string }>) => {
      if (data?.type === 'signed-out') {
        setEncryptionKey(undefined);
        setDbName(undefined);
        setPendingAuth(undefined);
      }
    };
    return () => { channel.close(); channelRef.current = null; };
  }, [appName]);

  // ── signOut: clear in-memory key only — IDB entry (isDefault) preserved ──
  // On page reload, the bootstrap will find the IDB entry and re-derive the key
  // via WebAuthn automatically. signOut only ends the current session.
  const signOut = useCallback(() => {
    setEncryptionKey(undefined);
    setDbName(undefined);
    setPendingAuth(undefined);
    channelRef.current?.postMessage({ type: 'signed-out' });
  }, []);

  // ── register: full invite flow ────────────────────────────────────────────
  const register = useCallback(async (
    url: string,
    options?: RegisterOptions,
  ): Promise<{ userDetails: MXDBUserDetails }> => {
    const requestId = extractRequestId(url);
    if (requestId == null) throw new Error('Invalid invite URL: missing requestId parameter.');

    const { userDetails, registrationToken } = await fetchInitialRegistration(appName, requestId);
    const newDbName = generateDbName();
    const { credentialId, prfOutput } = await createWebAuthnCredential(userDetails, options?.appName);
    const encKey = await deriveKeyFromPrfOutput(prfOutput);
    const keyHash = await computeKeyHash(encKey);
    const deviceDetails = options?.deviceDetails ?? collectDeviceDetails();
    const token = await fetchCompleteRegistration(appName, registrationToken, keyHash, deviceDetails);

    await saveEntry({ id: ulid(), credentialId, dbName: newDbName, isDefault: true });

    setDbName(newDbName);
    setEncryptionKey(encKey);
    setPendingAuth({ token, keyHash });

    return { userDetails };
  }, [appName, saveEntry]);

  const authContext = useMemo(() => ({
    isAuthenticated: encryptionKey != null,
    signOut,
    register,
  }), [encryptionKey, signOut, register]);

  if (!loaded) return null;

  return (
    <AuthContext.Provider value={authContext}>
      {encryptionKey != null && dbName != null ? (
        <DbsProvider name={dbName} encryptionKey={encryptionKey} collections={collections} logger={dbsLogger}>
          <TokenProvider
            appName={appName}
            host={host}
            collections={collections}
            onError={onError}
            initialAuth={pendingAuth}
          >
            {children}
          </TokenProvider>
        </DbsProvider>
      ) : children}
    </AuthContext.Provider>
  );
});
```

- [ ] **Step 2: Commit**

```bash
git -C c:/code/personal/mxdb add src/client/auth/AuthProvider.tsx
git -C c:/code/personal/mxdb commit -m "feat: add AuthProvider with WebAuthn, registration, and signOut"
```

---

## Task 5: Create TokenProvider

**Files:**
- Create: `src/client/auth/TokenProvider.tsx`

Reads the auth token from SQLite on mount. If SQLite is empty and `initialAuth` is provided (post-registration), writes it first. Passes the token to `SocketProvider` via props. The token passed to `SocketProvider` is fixed for the session lifetime — rotation updates SQLite and `socket.auth` directly without causing a reconnect.

- [ ] **Step 1: Create `TokenProvider.tsx`**

```typescript
// src/client/auth/TokenProvider.tsx
/**
 * Reads the auth token from SQLite (db.readAuth) on mount.
 * Writes initialAuth to SQLite if the table is empty (first registration).
 * Passes a fixed connectionToken to SocketProvider — token is never changed
 * mid-session to avoid unnecessary socket reconnects.
 * onTokenRotated callback writes the new token to SQLite for the next session.
 */
import { createComponent } from '@anupheaus/react-ui';
import type { ReactNode } from 'react';
import { useState, useEffect, useCallback } from 'react';
import { useDb } from '../providers/dbs';
import { SocketProvider } from './SocketProvider';
import type { MXDBCollection, MXDBError } from '../../common';

interface Props {
  appName: string;
  host?: string;
  collections: MXDBCollection[];
  onError?(error: MXDBError): void;
  /** Provided by AuthProvider immediately after registration when SQLite is still empty. */
  initialAuth?: { token: string; keyHash: string };
  children?: ReactNode;
}

export const TokenProvider = createComponent('TokenProvider', ({
  appName,
  host,
  collections,
  onError,
  initialAuth,
  children,
}: Props) => {
  const { db } = useDb();
  // connectionToken is fixed for this session — changing it would reconnect the socket.
  const [connectionToken, setConnectionToken] = useState<string | undefined>();
  const [keyHash, setKeyHash] = useState<string | undefined>();

  useEffect(() => {
    (async () => {
      let auth = await db.readAuth();
      if (auth == null && initialAuth != null) {
        await db.writeAuth(initialAuth.token, initialAuth.keyHash);
        auth = initialAuth;
      }
      setConnectionToken(auth?.token);
      setKeyHash(auth?.keyHash);
    })();
  }, [db]);

  // Called by SocketProvider after the server rotates the token.
  // Writes to SQLite only — does NOT update connectionToken so no reconnect occurs.
  // SocketProvider updates socket.auth directly for reconnect scenarios.
  const onTokenRotated = useCallback(async (newToken: string) => {
    if (keyHash == null) return;
    await db.writeAuth(newToken, keyHash);
  }, [db, keyHash]);

  if (connectionToken == null || keyHash == null) return null;

  return (
    <SocketProvider
      appName={appName}
      host={host}
      token={connectionToken}
      keyHash={keyHash}
      collections={collections}
      onError={onError}
      onTokenRotated={onTokenRotated}
    >
      {children}
    </SocketProvider>
  );
});
```

- [ ] **Step 2: Commit**

```bash
git -C c:/code/personal/mxdb add src/client/auth/TokenProvider.tsx
git -C c:/code/personal/mxdb commit -m "feat: add TokenProvider — reads/writes SQLite token, fixed connectionToken for session"
```

---

## Task 6: Create SocketProvider

**Files:**
- Create: `src/client/auth/SocketProvider.tsx`

Wraps `SocketAPI`. An inner component (`SocketInner`) sits inside `SocketAPI` and uses `useEvent(mxdbTokenRotated)` to handle rotation: it calls the `onTokenRotated` prop (which updates SQLite via `TokenProvider`) then mutates `socket.auth` so the next reconnect uses the new token. Also renders `ClientToServerSyncProvider`, `ClientToServerProvider`, `ServerToClientProvider`.

- [ ] **Step 1: Create `SocketProvider.tsx`**

```typescript
// src/client/auth/SocketProvider.tsx
/**
 * Wraps SocketAPI and handles token rotation internally.
 *
 * Token rotation flow:
 *  1. Server emits mxdbTokenRotated({ newToken })
 *  2. SocketInner receives it, calls onTokenRotated(newToken) → TokenProvider writes to SQLite
 *  3. SocketInner mutates socket.auth so the next reconnect uses the new token
 *  No React state update → no socket reconnect triggered.
 */
import { createComponent } from '@anupheaus/react-ui';
import type { ReactNode } from 'react';
import { SocketAPI, useEvent, useSocketAPI } from '@anupheaus/nexus/client';
import { mxdbTokenRotated } from '../../common';
import { ClientToServerSyncProvider } from '../providers/client-to-server';
import { ClientToServerProvider } from '../providers/client-to-server';
import { ServerToClientProvider } from '../providers/server-to-client';
import type { MXDBCollection, MXDBError } from '../../common';

interface Props {
  appName: string;
  host?: string;
  token: string;
  keyHash: string;
  collections: MXDBCollection[];
  onError?(error: MXDBError): void;
  onTokenRotated(newToken: string): Promise<void>;
  children?: ReactNode;
}

// Inner component — must be a child of SocketAPI to use useEvent / useSocketAPI.
interface InnerProps {
  keyHash: string;
  collections: MXDBCollection[];
  onError?(error: MXDBError): void;
  onTokenRotated(newToken: string): Promise<void>;
  children?: ReactNode;
}

const SocketInner = createComponent('SocketInner', ({
  keyHash,
  collections,
  onError,
  onTokenRotated,
  children,
}: InnerProps) => {
  const { getRawSocket } = useSocketAPI();
  const onTokenRotatedEvent = useEvent(mxdbTokenRotated);

  onTokenRotatedEvent(async ({ newToken }) => {
    await onTokenRotated(newToken);
    // Mutate socket.auth so the next reconnect authenticates with the new token.
    const socket = getRawSocket();
    if (socket != null) {
      socket.auth = { ...(socket.auth as Record<string, string>), token: newToken };
    }
  });

  return (
    <ClientToServerSyncProvider collections={collections} onError={onError}>
      <ClientToServerProvider />
      <ServerToClientProvider />
      {children}
    </ClientToServerSyncProvider>
  );
});

export const SocketProvider = createComponent('SocketProvider', ({
  appName,
  host,
  token,
  keyHash,
  collections,
  onError,
  onTokenRotated,
  children,
}: Props) => (
  <SocketAPI name={appName} host={host} auth={{ token, keyHash }}>
    <SocketInner
      keyHash={keyHash}
      collections={collections}
      onError={onError}
      onTokenRotated={onTokenRotated}
    >
      {children}
    </SocketInner>
  </SocketAPI>
));
```

- [ ] **Step 2: Commit**

```bash
git -C c:/code/personal/mxdb add src/client/auth/SocketProvider.tsx
git -C c:/code/personal/mxdb commit -m "feat: add SocketProvider with inline token rotation handling"
```

---

## Task 7: Update MXDBSync

**Files:**
- Modify: `src/client/MXDBSync.tsx`

`MXDBSync` no longer manages auth directly — it just composes `IndexedDbProvider` → `AuthProvider`. `AuthProvider` internally composes `DbsProvider` → `TokenProvider` → `SocketProvider` when authenticated.

- [ ] **Step 1: Rewrite `MXDBSync.tsx`**

```typescript
// src/client/MXDBSync.tsx
import { createComponent } from '@anupheaus/react-ui';
import type { ReactNode } from 'react';
import type { MXDBCollection, MXDBError, UnauthorisedOperationDetails } from '../common';
import type { Logger } from '@anupheaus/common';
import { useEffect, useMemo } from 'react';
import { LoggerProvider } from '@anupheaus/react-ui';
import { IndexedDbProvider } from './auth/IndexedDbProvider';
import { AuthProvider } from './auth/AuthProvider';
import { ConflictResolutionContext } from './providers';
import { setupBrowserTools } from './utils/setupBrowserTools';

interface Props {
  host?: string;
  name: string;
  logger?: Logger;
  collections: MXDBCollection[];
  onInvalidToken?(): Promise<void>;
  onUnauthorisedOperation?(): Promise<UnauthorisedOperationDetails>;
  onError?(error: MXDBError): void;
  onConflictResolution?(message: string): Promise<boolean>;
  children?: ReactNode;
}

export const MXDBSync = createComponent('MXDBSync', ({
  host,
  name,
  logger,
  collections,
  onError,
  onConflictResolution,
  children,
}: Props) => {
  if (host != null) {
    const protocol = host.match(/^([a-z][a-z0-9+\-.]*:\/\/)/i)?.[1]?.toLowerCase();
    if (protocol != null && protocol !== 'wss://') {
      throw new Error(`MXDBSync: connection to "${host}" uses an insecure protocol. Only wss:// is allowed (§4.7).`);
    }
  }

  useEffect(() => { setupBrowserTools(); }, []);

  const conflictResolutionContext = useMemo(() => ({ onConflictResolution }), [onConflictResolution]);

  return (
    <LoggerProvider logger={logger} loggerName="MXDB">
      <ConflictResolutionContext.Provider value={conflictResolutionContext}>
        <IndexedDbProvider appName={name}>
          <AuthProvider appName={name} host={host} collections={collections} onError={onError}>
            {children}
          </AuthProvider>
        </IndexedDbProvider>
      </ConflictResolutionContext.Provider>
    </LoggerProvider>
  );
});
```

- [ ] **Step 2: Commit**

```bash
git -C c:/code/personal/mxdb add src/client/MXDBSync.tsx
git -C c:/code/personal/mxdb commit -m "refactor: simplify MXDBSync to compose IndexedDbProvider + AuthProvider"
```

---

## Task 8: Update public hooks

**Files:**
- Modify: `src/client/hooks/useMXDBInvite.ts`
- Modify: `src/client/hooks/useMXDBSignOut.ts`
- Modify: `src/client/hooks/useMXDBAuth.ts`

- [ ] **Step 1: Rewrite `useMXDBInvite.ts`**

The registration logic has moved to `AuthProvider`. This hook is now a thin wrapper.

```typescript
// src/client/hooks/useMXDBInvite.ts
import { useContext } from 'react';
import { AuthContext } from '../auth/AuthContext';
import type { RegisterOptions } from '../auth/AuthContext';
import type { MXDBUserDetails } from '../../common/models';

export type { RegisterOptions };

export function useMXDBInvite(): (url: string, options?: RegisterOptions) => Promise<{ userDetails: MXDBUserDetails }> {
  const { register } = useContext(AuthContext);
  return register;
}
```

- [ ] **Step 2: Rewrite `useMXDBSignOut.ts`**

```typescript
// src/client/hooks/useMXDBSignOut.ts
import { useContext, useCallback } from 'react';
import { AuthContext } from '../auth/AuthContext';

export interface UseMXDBSignOutResult {
  signOut(): void;
}

export function useMXDBSignOut(): UseMXDBSignOutResult {
  const { signOut } = useContext(AuthContext);
  return { signOut: useCallback(() => signOut(), [signOut]) };
}
```

- [ ] **Step 3: Rewrite `useMXDBAuth.ts`**

```typescript
// src/client/hooks/useMXDBAuth.ts
import { useContext } from 'react';
import { AuthContext } from '../auth/AuthContext';

export interface UseMXDBAuthResult {
  isAuthenticated: boolean;
}

export function useMXDBAuth(): UseMXDBAuthResult {
  const { isAuthenticated } = useContext(AuthContext);
  return { isAuthenticated };
}
```

- [ ] **Step 4: Commit**

```bash
git -C c:/code/personal/mxdb add src/client/hooks/useMXDBInvite.ts src/client/hooks/useMXDBSignOut.ts src/client/hooks/useMXDBAuth.ts
git -C c:/code/personal/mxdb commit -m "refactor: update public hooks to use AuthContext and IndexedDbContext"
```

---

## Task 9: Delete old files and verify build

**Files:**
- Delete: `src/client/auth/AuthTokenContext.ts`
- Delete: `src/client/auth/SqliteTokenSync.tsx`
- Delete: `src/client/auth/TokenRotationProvider.tsx`
- Delete: `src/client/auth/IndexedDbBridge.tsx`

- [ ] **Step 1: Delete the old files**

```bash
git -C c:/code/personal/mxdb rm src/client/auth/AuthTokenContext.ts src/client/auth/SqliteTokenSync.tsx src/client/auth/TokenRotationProvider.tsx src/client/auth/IndexedDbBridge.tsx
```

- [ ] **Step 2: Check for any remaining imports of deleted files**

```bash
grep -r "AuthTokenContext\|SqliteTokenSync\|TokenRotationProvider\|IndexedDbBridge" c:/code/personal/mxdb/src --include="*.ts" --include="*.tsx" -l
```

Expected: no output. If any files appear, open them and update the import to the new provider.

- [ ] **Step 3: Run TypeScript compiler**

```bash
cd c:/code/personal/mxdb && npx tsc --noEmit 2>&1
```

Expected: zero errors. Fix any that appear before continuing.

- [ ] **Step 4: Run the test suite**

```bash
cd c:/code/personal/mxdb && npx vitest run 2>&1
```

Expected: all existing tests pass (the refactor does not touch collection or sync logic).

- [ ] **Step 5: Commit deletions**

```bash
git -C c:/code/personal/mxdb commit -m "refactor: delete AuthTokenContext, SqliteTokenSync, TokenRotationProvider, IndexedDbBridge"
```

---

## Task 10: Build and verify no package regressions

- [ ] **Step 1: Build the client bundle**

```bash
cd c:/code/personal/mxdb && npx webpack --mode development --name client 2>&1 | tail -20
```

Expected: build succeeds with no errors (warnings about bundle size are fine).

- [ ] **Step 2: Verify exported public API is unchanged**

```bash
grep -r "export" c:/code/personal/mxdb/src/client/index.ts
grep -r "export" c:/code/personal/mxdb/src/client/hooks/index.ts
```

Expected output (unchanged from before):
```
// index.ts
export * from './MXDBSync';
export * from './useMXDBSync';
export * from './useRecord';
export * from './hooks';
export { MXDBCollectionEvent } from './providers/dbs/models';

// hooks/index.ts
export * from './useCollection';
export * from './useMXDBAuth';
export * from './useMXDBInvite';
export * from './useMXDBSignOut';
```

- [ ] **Step 3: Final commit**

```bash
git -C c:/code/personal/mxdb add -A
git -C c:/code/personal/mxdb commit -m "feat: complete auth provider refactor — IndexedDbProvider/AuthProvider/TokenProvider/SocketProvider chain"
```
