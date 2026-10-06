import { clearGuestEncryption, loadGuestEncryption } from './guestEncryption';

/** What the encrypted-database writer leaves in the OPFS root for a database: the blob and a renamed orphan swap file. */
const LOCAL_DATABASE_FILE_SUFFIXES = ['.enc', '.enc.crswap.old'];

type GetDirectory = () => Promise<FileSystemDirectoryHandle>;

/** Removes one OPFS file, treating a missing file (or no OPFS at all) as already gone. */
async function removeOpfsFile(getDirectory: GetDirectory, fileName: string): Promise<void> {
  try {
    const root = await getDirectory();
    await root.removeEntry(fileName);
  } catch { /* not there, or storage unavailable: nothing left to remove */ }
}

/**
 * Removes everything a guest session left on this device (sc-733): its local database (the encrypted blob in OPFS)
 * and the key that opens it. For a guest whose session has ended while the app was closed — the server refuses it, so
 * the app never signs the guest in and `MXDBSync` never runs its own sign-out clean-up. Call it only while that
 * database is not open. Never throws; resolves whether there was a guest key to forget.
 */
export async function forgetGuestSession(appName: string, userId: string): Promise<boolean> {
  const stored = loadGuestEncryption(appName, userId);
  clearGuestEncryption(appName, userId);
  if (stored == null) return false;
  const getDirectory = globalThis.navigator?.storage?.getDirectory?.bind(globalThis.navigator.storage) as GetDirectory | undefined;
  if (getDirectory != null) {
    for (const suffix of LOCAL_DATABASE_FILE_SUFFIXES) await removeOpfsFile(getDirectory, `${stored.dbName}${suffix}`);
  }
  return true;
}
