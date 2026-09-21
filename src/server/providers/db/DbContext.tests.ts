import { describe, it, expect, beforeEach } from 'vitest';
import { Logger } from '@anupheaus/common';
import { runInDbScope, setDb, setServerToClientSync, useDb, useServerToClientSynchronisation } from './DbContext';
import type { ServerDb } from './ServerDb';
import { ServerToClientSynchronisation } from '../../ServerToClientSynchronisation';

describe('DbContext', () => {
  const fakeDb = { isFakeDb: true } as unknown as ServerDb;

  beforeEach(() => {
    setDb(fakeDb);
    setServerToClientSync(ServerToClientSynchronisation.createNoOp([], new Logger('test')));
  });

  it('useDb returns the db set by setDb', () => {
    expect(useDb()).toBe(fakeDb);
  });

  it('useServerToClientSynchronisation returns the S2C instance', () => {
    const s2c = useServerToClientSynchronisation();
    expect(s2c).toBeInstanceOf(ServerToClientSynchronisation);
  });

  it('useDb returns the same db from within an async handler', async () => {
    const result = await Promise.resolve().then(() => useDb());
    expect(result).toBe(fakeDb);
  });

  it('useDb returns the same db from within a nested async callback', async () => {
    const result = await new Promise<ServerDb>(resolve => {
      setTimeout(() => resolve(useDb()), 0);
    });
    expect(result).toBe(fakeDb);
  });

  describe('runInDbScope', () => {
    const otherDb = { isOtherDb: true } as unknown as ServerDb;

    it('applies a setDb inside the scope but restores the ambient db afterwards', () => {
      const inside = runInDbScope(() => {
        setDb(otherDb);
        return useDb();
      });
      expect(inside).toBe(otherDb);
      // The switch is confined to the scope — the surrounding ambient db is unchanged.
      expect(useDb()).toBe(fakeDb);
    });

    it('restores the ambient db after an async delegate settles', async () => {
      const inside = await runInDbScope(async () => {
        setDb(otherDb);
        await Promise.resolve();
        return useDb();
      });
      expect(inside).toBe(otherDb);
      expect(useDb()).toBe(fakeDb);
    });

    it('nested scopes each restore to their parent scope', () => {
      const deeperDb = { isDeeperDb: true } as unknown as ServerDb;
      runInDbScope(() => {
        setDb(otherDb);
        const innermost = runInDbScope(() => {
          setDb(deeperDb);
          return useDb();
        });
        expect(innermost).toBe(deeperDb);
        // Inner scope restored to this frame's db, not the global default.
        expect(useDb()).toBe(otherDb);
      });
      expect(useDb()).toBe(fakeDb);
    });
  });
});
