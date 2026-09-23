import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Logger } from '@anupheaus/common';
import type { Socket } from 'socket.io';
import { registerClientS2C } from './clientS2CStore';
import { runInDbScope, setDb, setServerToClientSync, useDb, useServerToClientSynchronisation } from './DbContext';
import type { ServerDb } from './ServerDb';
import { ServerToClientSynchronisation } from '../../ServerToClientSynchronisation';

// The connected socket is a nexus (external) concern; stub it so tests can simulate being inside,
// or outside, a client connection.
const mockUseClient = vi.fn<() => Socket | undefined>();
vi.mock('@anupheaus/nexus/server', async importOriginal => {
  const actual = await importOriginal() as object;
  return { ...actual, useClient: () => mockUseClient() };
});

describe('DbContext', () => {
  const fakeDb = { isFakeDb: true } as unknown as ServerDb;

  beforeEach(() => {
    mockUseClient.mockReturnValue(undefined);
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

  describe('useServerToClientSynchronisation inside a client connection', () => {
    it('returns the S2C registered for the connected client in preference to the ambient one', () => {
      const socket = {} as Socket;
      const clientS2C = ServerToClientSynchronisation.createNoOp([], new Logger('client'));
      registerClientS2C(socket, clientS2C);
      mockUseClient.mockReturnValue(socket);

      expect(useServerToClientSynchronisation()).toBe(clientS2C);
    });

    it('falls back to the ambient S2C when the connected client has none registered', () => {
      const ambientS2C = ServerToClientSynchronisation.createNoOp([], new Logger('ambient'));
      setServerToClientSync(ambientS2C);
      mockUseClient.mockReturnValue({} as Socket);

      expect(useServerToClientSynchronisation()).toBe(ambientS2C);
    });
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
