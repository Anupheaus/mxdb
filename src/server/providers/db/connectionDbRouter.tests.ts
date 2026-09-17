import { describe, it, expect, vi } from 'vitest';
import { createConnectionDbPool, resolveAndScopeConnection } from './connectionDbRouter';
import type { ConnectionDbTarget, ConnectionHandshake } from '../../internalModels';
import type { ServerDb } from './ServerDb';

const target = (dbName: string, mongoDbUrl = 'mongodb://localhost:27017'): ConnectionDbTarget => ({ dbName, mongoDbUrl });
const handshake: ConnectionHandshake = { headers: {} };

describe('createConnectionDbPool', () => {
  it('returns the same ServerDb instance for the same target key', () => {
    const makeServerDb = vi.fn((t: ConnectionDbTarget) => ({ marker: t.dbName } as unknown as ServerDb));
    const pool = createConnectionDbPool(makeServerDb);

    const first = pool.getOrCreate(target('tenant-a'));
    const second = pool.getOrCreate(target('tenant-a'));

    expect(second).toBe(first);
    expect(makeServerDb).toHaveBeenCalledTimes(1);
  });

  it('creates a distinct ServerDb instance for a different target key', () => {
    const makeServerDb = vi.fn((t: ConnectionDbTarget) => ({ marker: t.dbName } as unknown as ServerDb));
    const pool = createConnectionDbPool(makeServerDb);

    const first = pool.getOrCreate(target('tenant-a'));
    const second = pool.getOrCreate(target('tenant-b'));

    expect(second).not.toBe(first);
    expect(makeServerDb).toHaveBeenCalledTimes(2);
  });

  it('keys the pool by both mongoDbUrl and dbName', () => {
    const makeServerDb = vi.fn((t: ConnectionDbTarget) => ({ marker: t.dbName } as unknown as ServerDb));
    const pool = createConnectionDbPool(makeServerDb);

    pool.getOrCreate(target('tenant-a', 'mongodb://host-1:27017'));
    pool.getOrCreate(target('tenant-a', 'mongodb://host-2:27017'));

    expect(makeServerDb).toHaveBeenCalledTimes(2);
  });

  it('closeAll closes every pooled ServerDb and clears the pool', async () => {
    const close = vi.fn(async () => {});
    const makeServerDb = vi.fn(() => ({ close } as unknown as ServerDb));
    const pool = createConnectionDbPool(makeServerDb);

    pool.getOrCreate(target('tenant-a'));
    pool.getOrCreate(target('tenant-b'));
    await pool.closeAll();

    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('resolveAndScopeConnection', () => {
  it('calls setDb with the pooled db when the resolver returns a target', async () => {
    const pooledDb = {} as unknown as ServerDb;
    const setDb = vi.fn();
    const getOrCreateServerDb = vi.fn(() => pooledDb);
    const resolveConnectionDb = vi.fn(async (_h: ConnectionHandshake) => target('tenant-a'));

    await resolveAndScopeConnection(handshake, { resolveConnectionDb, getOrCreateServerDb, setDb });

    expect(getOrCreateServerDb).toHaveBeenCalledWith(target('tenant-a'));
    expect(setDb).toHaveBeenCalledWith(pooledDb);
  });

  it('does not call setDb when the resolver returns null', async () => {
    const setDb = vi.fn();
    const getOrCreateServerDb = vi.fn(() => ({} as unknown as ServerDb));
    const resolveConnectionDb = vi.fn(async (_h: ConnectionHandshake) => null);

    await resolveAndScopeConnection(handshake, { resolveConnectionDb, getOrCreateServerDb, setDb });

    expect(getOrCreateServerDb).not.toHaveBeenCalled();
    expect(setDb).not.toHaveBeenCalled();
  });

  it('passes the handshake through to the resolver', async () => {
    const setDb = vi.fn();
    const getOrCreateServerDb = vi.fn(() => ({} as unknown as ServerDb));
    const resolveConnectionDb = vi.fn(async (_h: ConnectionHandshake) => null);

    await resolveAndScopeConnection(handshake, { resolveConnectionDb, getOrCreateServerDb, setDb });

    expect(resolveConnectionDb).toHaveBeenCalledWith(handshake);
  });
});
