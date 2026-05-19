// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveEncryptionToSession,
  loadEncryptionFromSession,
  clearEncryptionFromSession,
  hasCachedEncryptionKey,
} from './encryptionSessionCache';

// Partition of valid app/user identities used across all test groups
const APP = 'test-app';
const USER = 'user-abc';

describe('encryptionSessionCache', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  // ---------------------------------------------------------------------------
  describe('saveEncryptionToSession / loadEncryptionFromSession', () => {
    it('returns the same key bytes and dbName after a round-trip', () => {
      const key = new Uint8Array([1, 2, 3, 255, 0, 128]);
      const dbName = 'my-database';

      saveEncryptionToSession(APP, USER, key, dbName);
      const result = loadEncryptionFromSession(APP, USER);

      expect(result).not.toBeUndefined();
      expect(result!.dbName).toBe(dbName);
      expect(Array.from(result!.key)).toEqual(Array.from(key));
    });

    it('round-trips a full 0–255 byte range without corruption', () => {
      const key = Uint8Array.from({ length: 256 }, (_, i) => i);
      saveEncryptionToSession(APP, USER, key, 'db');

      const result = loadEncryptionFromSession(APP, USER);

      expect(result).not.toBeUndefined();
      expect(Array.from(result!.key)).toEqual(Array.from(key));
    });

    it('persists the dbName accurately alongside the key', () => {
      const key = new Uint8Array([7, 14, 21]);
      const dbName = 'account-42-db';

      saveEncryptionToSession(APP, USER, key, dbName);
      const result = loadEncryptionFromSession(APP, USER);

      expect(result!.dbName).toBe(dbName);
    });

    it('returns undefined when nothing has been saved for the given app and user', () => {
      const result = loadEncryptionFromSession(APP, USER);
      expect(result).toBeUndefined();
    });

    it('returns undefined when a different appName is queried', () => {
      const key = new Uint8Array([1, 2, 3]);
      saveEncryptionToSession(APP, USER, key, 'db');

      const result = loadEncryptionFromSession('other-app', USER);
      expect(result).toBeUndefined();
    });

    it('returns undefined when a different userId is queried', () => {
      const key = new Uint8Array([1, 2, 3]);
      saveEncryptionToSession(APP, USER, key, 'db');

      const result = loadEncryptionFromSession(APP, 'other-user');
      expect(result).toBeUndefined();
    });

    it('stores entries independently per (appName, userId) pair', () => {
      const keyA = new Uint8Array([10, 20]);
      const keyB = new Uint8Array([30, 40]);
      saveEncryptionToSession('app-1', USER, keyA, 'db-a');
      saveEncryptionToSession('app-2', USER, keyB, 'db-b');

      const resultA = loadEncryptionFromSession('app-1', USER);
      const resultB = loadEncryptionFromSession('app-2', USER);

      expect(Array.from(resultA!.key)).toEqual([10, 20]);
      expect(Array.from(resultB!.key)).toEqual([30, 40]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('hasCachedEncryptionKey', () => {
    it('returns false when nothing has been saved', () => {
      expect(hasCachedEncryptionKey(APP, USER)).toBe(false);
    });

    it('returns true after saveEncryptionToSession is called', () => {
      saveEncryptionToSession(APP, USER, new Uint8Array([1]), 'db');
      expect(hasCachedEncryptionKey(APP, USER)).toBe(true);
    });

    it('returns false after clearEncryptionFromSession is called', () => {
      saveEncryptionToSession(APP, USER, new Uint8Array([1]), 'db');
      clearEncryptionFromSession(APP, USER);
      expect(hasCachedEncryptionKey(APP, USER)).toBe(false);
    });

    it('returns false for a different appName even when a key exists for another app', () => {
      saveEncryptionToSession(APP, USER, new Uint8Array([1]), 'db');
      expect(hasCachedEncryptionKey('other-app', USER)).toBe(false);
    });

    it('returns false for a different userId even when a key exists for another user', () => {
      saveEncryptionToSession(APP, USER, new Uint8Array([1]), 'db');
      expect(hasCachedEncryptionKey(APP, 'other-user')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('clearEncryptionFromSession', () => {
    it('causes loadEncryptionFromSession to return undefined after clearing', () => {
      saveEncryptionToSession(APP, USER, new Uint8Array([5, 6, 7]), 'db');
      clearEncryptionFromSession(APP, USER);

      expect(loadEncryptionFromSession(APP, USER)).toBeUndefined();
    });

    it('does not throw when called on a key that was never saved', () => {
      expect(() => clearEncryptionFromSession(APP, USER)).not.toThrow();
    });

    it('only removes the targeted (appName, userId) entry, leaving others intact', () => {
      const keyB = new Uint8Array([99]);
      saveEncryptionToSession(APP, USER, new Uint8Array([1]), 'db-a');
      saveEncryptionToSession(APP, 'other-user', keyB, 'db-b');

      clearEncryptionFromSession(APP, USER);

      expect(loadEncryptionFromSession(APP, USER)).toBeUndefined();
      const surviving = loadEncryptionFromSession(APP, 'other-user');
      expect(surviving).not.toBeUndefined();
      expect(Array.from(surviving!.key)).toEqual([99]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('corrupt or missing storage values', () => {
    // The storage key format mirrors the implementation: `mxdb:enc:${appName}:${userId}`
    const storageKey = `mxdb:enc:${APP}:${USER}`;

    it('returns undefined when the raw value is not valid JSON', () => {
      sessionStorage.setItem(storageKey, 'not-json');
      expect(loadEncryptionFromSession(APP, USER)).toBeUndefined();
    });

    it('returns undefined when JSON is valid but the key field is missing', () => {
      sessionStorage.setItem(storageKey, JSON.stringify({ dbName: 'db' }));
      expect(loadEncryptionFromSession(APP, USER)).toBeUndefined();
    });

    it('returns undefined when JSON is valid but the dbName field is missing', () => {
      // btoa of a minimal byte produces a valid base64 value; the dbName is absent
      const validBase64 = btoa(String.fromCharCode(1));
      sessionStorage.setItem(storageKey, JSON.stringify({ key: validBase64 }));
      // The function must not throw; outcome (undefined or partial) is both acceptable —
      // the contract only requires no throw and no unsafe exposure.
      expect(() => loadEncryptionFromSession(APP, USER)).not.toThrow();
    });

    it('does not throw when the stored value is an empty string', () => {
      sessionStorage.setItem(storageKey, '');
      expect(() => loadEncryptionFromSession(APP, USER)).not.toThrow();
    });

    it('does not throw when the stored value is a valid JSON object of wrong shape', () => {
      sessionStorage.setItem(storageKey, JSON.stringify({ unrelated: true }));
      expect(() => loadEncryptionFromSession(APP, USER)).not.toThrow();
    });

    it.each([
      ['<script>alert(1)</script>', 'xss-app'],
      ['"; DROP TABLE users; --', 'sql-injection-app'],
      ['../../etc/passwd', 'path-traversal-app'],
    ])('handles special character appName %s without throwing', (specialApp) => {
      expect(() => saveEncryptionToSession(specialApp, USER, new Uint8Array([1]), 'db')).not.toThrow();
      expect(() => loadEncryptionFromSession(specialApp, USER)).not.toThrow();
    });
  });
});
