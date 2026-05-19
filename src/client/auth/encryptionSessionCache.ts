const SESSION_KEY_PREFIX = 'mxdb:enc';

interface CachedEncryption {
  key: string; // base64-encoded encryption key
  dbName: string;
}

function buildSessionKey(appName: string, userId: string): string {
  return `${SESSION_KEY_PREFIX}:${appName}:${userId}`;
}

export function saveEncryptionToSession(appName: string, userId: string, key: Uint8Array, dbName: string): void {
  try {
    const data: CachedEncryption = {
      key: btoa(Array.from(key, b => String.fromCharCode(b)).join('')),
      dbName,
    };
    sessionStorage.setItem(buildSessionKey(appName, userId), JSON.stringify(data));
  } catch { /* ignore storage errors */ }
}

export function loadEncryptionFromSession(appName: string, userId: string): { key: Uint8Array; dbName: string } | undefined {
  try {
    const raw = sessionStorage.getItem(buildSessionKey(appName, userId));
    if (raw == null) return undefined;
    const { key: b64, dbName } = JSON.parse(raw) as CachedEncryption;
    return { key: Uint8Array.from(atob(b64), c => c.charCodeAt(0)), dbName };
  } catch { return undefined; }
}

export function clearEncryptionFromSession(appName: string, userId: string): void {
  try { sessionStorage.removeItem(buildSessionKey(appName, userId)); } catch { /* ignore */ }
}

/** Returns true if a PRF-derived encryption key is cached in sessionStorage for this user. */
export function hasCachedEncryptionKey(appName: string, userId: string): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(buildSessionKey(appName, userId)) != null;
  } catch { return false; }
}
