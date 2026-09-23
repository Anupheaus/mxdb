/**
 * State updater for the encryption key: keeps the CURRENT key instance when the next key has the same
 * bytes. `DbsProvider` rebuilds the database whenever the key's identity changes, and the same key is
 * routinely re-applied as a new `Uint8Array` — the PRF handler sets it, then the session-cache restore
 * sets it again when the (re)connected socket delivers the user. That second swap tore the database
 * down mid-sync, losing the server's first push and leaving queries loading forever.
 */
export function keepEncryptionKey(current: Uint8Array | undefined, next: Uint8Array | undefined): Uint8Array | undefined {
  if (current == null || next == null) return next;
  if (current.length !== next.length) return next;
  // Plain byte compare — this is an idempotence check on our own key, not an authentication decision.
  return current.every((byte, index) => byte === next[index]) ? current : next;
}
