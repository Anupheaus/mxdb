// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { forgetGuestSession } from './forgetGuestSession';
import { loadGuestEncryption, storeGuestEncryptionKey } from './guestEncryption';

const APP = 'test-app';
const USER = 'guest-user';

/** A fake OPFS root holding the named files. */
function stubOpfs(fileNames: string[]): Set<string> {
  const files = new Set(fileNames);
  const root = {
    removeEntry: vi.fn(async (name: string) => {
      if (!files.delete(name)) throw new DOMException('Not found', 'NotFoundError');
    }),
  };
  vi.stubGlobal('navigator', { ...navigator, storage: { getDirectory: async () => root } });
  return files;
}

describe('forgetGuestSession', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('removes the guest\'s key and their local database, and only theirs', async () => {
    const files = stubOpfs(['guest-db.enc', 'guest-db.enc.crswap.old', 'staff-account.enc']);
    storeGuestEncryptionKey(APP, { userId: USER, dbName: 'guest-db' });

    expect(await forgetGuestSession(APP, USER)).toBe(true);
    expect(loadGuestEncryption(APP, USER)).toBeUndefined();
    expect([...files]).toEqual(['staff-account.enc']);
  });

  it('is fine when the database was never written', async () => {
    stubOpfs([]);
    storeGuestEncryptionKey(APP, { userId: USER, dbName: 'guest-db' });

    expect(await forgetGuestSession(APP, USER)).toBe(true);
    expect(loadGuestEncryption(APP, USER)).toBeUndefined();
  });

  it('touches nothing when the user has no guest key', async () => {
    const files = stubOpfs(['staff-account.enc']);

    expect(await forgetGuestSession(APP, USER)).toBe(false);
    expect([...files]).toEqual(['staff-account.enc']);
  });

  it('still forgets the key where there is no OPFS', async () => {
    vi.stubGlobal('navigator', { ...navigator, storage: undefined });
    storeGuestEncryptionKey(APP, { userId: USER, dbName: 'guest-db' });

    expect(await forgetGuestSession(APP, USER)).toBe(true);
    expect(loadGuestEncryption(APP, USER)).toBeUndefined();
  });
});
