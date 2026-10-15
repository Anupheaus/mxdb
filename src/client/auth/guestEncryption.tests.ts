// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { storeGuestEncryptionKey, loadGuestEncryption, clearGuestEncryption } from './guestEncryption';
import { hasCachedEncryptionKey } from './encryptionSessionCache';

const APP = 'test-app';
const USER = 'guest-user';
const KEY_BYTES = 32;

describe('guestEncryption', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('stores a random 256-bit key and the database name, and reads them back', () => {
    storeGuestEncryptionKey(APP, { userId: USER, dbName: 'guest-db' });

    const stored = loadGuestEncryption(APP, USER);

    expect(stored?.dbName).toBe('guest-db');
    expect(stored?.key).toHaveLength(KEY_BYTES);
  });

  it('keeps the key in localStorage, so it outlives the tab (a guest has no passkey to derive it again)', () => {
    storeGuestEncryptionKey(APP, { userId: USER, dbName: 'guest-db' });
    sessionStorage.clear();

    expect(loadGuestEncryption(APP, USER)).toBeDefined();
  });

  it('makes a different key for each guest session', () => {
    storeGuestEncryptionKey(APP, { userId: USER, dbName: 'guest-db' });
    const first = loadGuestEncryption(APP, USER)!.key;
    storeGuestEncryptionKey(APP, { userId: USER, dbName: 'guest-db' });
    const second = loadGuestEncryption(APP, USER)!.key;

    expect(Array.from(second)).not.toEqual(Array.from(first));
  });

  it('is scoped per app and per user', () => {
    storeGuestEncryptionKey(APP, { userId: USER, dbName: 'guest-db' });

    expect(loadGuestEncryption('other-app', USER)).toBeUndefined();
    expect(loadGuestEncryption(APP, 'other-user')).toBeUndefined();
  });

  it('is gone after clearing', () => {
    storeGuestEncryptionKey(APP, { userId: USER, dbName: 'guest-db' });
    clearGuestEncryption(APP, USER);

    expect(loadGuestEncryption(APP, USER)).toBeUndefined();
  });

  it('reads a corrupted entry as no key', () => {
    localStorage.setItem(`mxdb:guest-enc:${APP}:${USER}`, '{not json');

    expect(loadGuestEncryption(APP, USER)).toBeUndefined();
  });

  it('counts as a cached key, so the passkey ceremony is skipped for a guest', () => {
    expect(hasCachedEncryptionKey(APP, USER)).toBe(false);
    storeGuestEncryptionKey(APP, { userId: USER, dbName: 'guest-db' });

    expect(hasCachedEncryptionKey(APP, USER)).toBe(true);
  });
});
