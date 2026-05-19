const SESSION_KEY_PREFIX = 'mxdb:enc';

interface CachedEncryption {
  key: string; // base64-encoded encryption key
  dbName: string;
}

function buildSessionKey(appName: string, userId: string): string {
  return `${SESSION_KEY_PREFIX}:${appName}:${userId}`;
}

/**
 * Caches the PRF-derived encryption key in sessionStorage so a page refresh skips the WebAuthn ceremony.
 *
 * Uses sessionStorage (tab-scoped) intentionally — the key is lost when the tab closes, limiting the
 * exposure window. Storage errors are silently ignored so auth flow is never interrupted by storage limits.
 *
 * @param appName - Application identifier for the session key
 * @param userId - User identifier for the session key
 * @param key - Raw AES key bytes derived from the WebAuthn PRF output
 * @param dbName - SQLite DB name to open alongside the key (userId or accountId)
 */
export function saveEncryptionToSession(appName: string, userId: string, key: Uint8Array, dbName: string): void {
  try {
    const data: CachedEncryption = {
      key: btoa(Array.from(key, b => String.fromCharCode(b)).join('')),
      dbName,
    };
    sessionStorage.setItem(buildSessionKey(appName, userId), JSON.stringify(data));
  } catch { /* ignore storage errors */ }
}

/**
 * Restores a previously cached encryption key from sessionStorage.
 *
 * Returns undefined if no cached key exists or if parsing fails (e.g. corrupted storage entry).
 * Call after sign-in to avoid re-running the WebAuthn ceremony on every page load.
 *
 * @param appName - Application identifier for the session key
 * @param userId - User identifier for the session key
 * @returns The cached encryption key and database name, or undefined if not found or invalid
 */
export function loadEncryptionFromSession(appName: string, userId: string): { key: Uint8Array; dbName: string } | undefined {
  try {
    const raw = sessionStorage.getItem(buildSessionKey(appName, userId));
    if (raw == null) return undefined;
    const { key: b64, dbName } = JSON.parse(raw) as CachedEncryption;
    return { key: Uint8Array.from(atob(b64), c => c.charCodeAt(0)), dbName };
  } catch { return undefined; }
}

/**
 * Removes the cached encryption key from sessionStorage.
 *
 * Call on sign-out or before starting a fresh WebAuthn ceremony. Storage errors are silently ignored.
 *
 * @param appName - Application identifier for the session key
 * @param userId - User identifier for the session key
 */
export function clearEncryptionFromSession(appName: string, userId: string): void {
  try { sessionStorage.removeItem(buildSessionKey(appName, userId)); } catch { /* ignore */ }
}

/** Returns true if a PRF-derived encryption key is cached in sessionStorage for this user. */
export function hasCachedEncryptionKey(appName: string, userId: string): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(buildSessionKey(appName, userId)) != null;
  } catch { return false; }
}
