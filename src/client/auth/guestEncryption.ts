const STORAGE_KEY_PREFIX = 'mxdb:guest-enc';
/** AES-256: the same size as the key `deriveKey` makes from a passkey's PRF output. */
const KEY_BYTES = 32;

interface StoredGuestEncryption {
  key: string; // base64-encoded encryption key
  dbName: string;
}

/** What a session signed in without a passkey opens its local database with. */
export interface GuestEncryptionTarget {
  userId: string;
  /** The local database to open. Use one of the guest's own, never a name staff on the same device use. */
  dbName: string;
}

function buildStorageKey(appName: string, userId: string): string {
  return `${STORAGE_KEY_PREFIX}:${appName}:${userId}`;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
}

/**
 * Gives a session that was signed in WITHOUT a passkey (a server-issued guest session) a key for its local database.
 * There is no PRF output to derive one from, so the key is random, and it is kept in `localStorage` rather than
 * `sessionStorage`: a guest cannot run a passkey ceremony to get it back when the tab closes. Call it before the app
 * signs in with the guest session (e.g. before reloading the page); `MXDBSync` then opens the database with it instead
 * of waiting for a passkey. Signing out removes it. Each call makes a new key, so a new guest session starts on an
 * empty database. Storage errors are ignored, as the passkey cache does.
 */
export function storeGuestEncryptionKey(appName: string, { userId, dbName }: GuestEncryptionTarget): void {
  const key = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const stored: StoredGuestEncryption = { key: toBase64(key), dbName };
  try {
    localStorage.setItem(buildStorageKey(appName, userId), JSON.stringify(stored));
  } catch { /* ignore storage errors: the app then waits for a sign-in it can complete */ }
}

/** The guest key stored for this user, or undefined when there is none or the entry cannot be read. */
export function loadGuestEncryption(appName: string, userId: string): { key: Uint8Array; dbName: string } | undefined {
  try {
    const raw = localStorage.getItem(buildStorageKey(appName, userId));
    if (raw == null) return undefined;
    const { key, dbName } = JSON.parse(raw) as StoredGuestEncryption;
    return { key: Uint8Array.from(atob(key), char => char.charCodeAt(0)), dbName };
  } catch { return undefined; }
}

/** Removes the guest key for this user (on sign-out). Storage errors are ignored. */
export function clearGuestEncryption(appName: string, userId: string): void {
  try { localStorage.removeItem(buildStorageKey(appName, userId)); } catch { /* ignore */ }
}
