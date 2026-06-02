import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../providers/dbs/Db';
import { handleRemoteSqliteQuery } from './remoteSqliteHandler';

describe('handleRemoteSqliteQuery', () => {
  it('denies mutating SQL when gate returns false', async () => {
    const queryRaw = vi.fn();
    const execRaw = vi.fn();
    const db = { queryRaw, execRaw } as unknown as Db;
    const ensureMutatingAllowed = vi.fn().mockResolvedValue(false);

    const res = await handleRemoteSqliteQuery(db, {
      requestId: 'r1',
      sql: 'UPDATE users SET name = ?',
      params: ['Alice'],
      requestedBy: 'operator-1',
    }, ensureMutatingAllowed);

    expect(queryRaw).not.toHaveBeenCalled();
    expect(execRaw).not.toHaveBeenCalled();
    expect(ensureMutatingAllowed).toHaveBeenCalledTimes(1);
    expect(res.requestId).toBe('r1');
    expect(res.rows).toEqual([]);
    expect(res.error?.message).toBe('MXDB_REMOTE_MUTATING_SQL_NOT_ALLOWED');
    expect(res.elapsedMs).toBeTypeOf('number');
  });

  it('executes mutating SQL when gate returns true', async () => {
    const queryRaw = vi.fn();
    const execRaw = vi.fn().mockResolvedValue(undefined);
    const db = { queryRaw, execRaw } as unknown as Db;
    const ensureMutatingAllowed = vi.fn().mockResolvedValue(true);

    const res = await handleRemoteSqliteQuery(db, {
      requestId: 'r1b',
      sql: 'UPDATE users SET name = ?',
      params: ['Alice'],
      requestedBy: 'operator-1',
    }, ensureMutatingAllowed);

    expect(queryRaw).not.toHaveBeenCalled();
    expect(execRaw).toHaveBeenCalledTimes(1);
    expect(execRaw).toHaveBeenCalledWith('UPDATE users SET name = ?', ['Alice']);
    expect(res.requestId).toBe('r1b');
    expect(res.rows).toEqual([]);
    expect(res.error).toBeUndefined();
  });

  it('executes read-only SQL and returns rows', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ a: 1 }]);
    const execRaw = vi.fn();
    const db = { queryRaw, execRaw } as unknown as Db;
    const ensureMutatingAllowed = vi.fn();

    const res = await handleRemoteSqliteQuery(db, {
      requestId: 'r2',
      sql: 'select 1 as a',
      requestedBy: 'operator-1',
    }, ensureMutatingAllowed);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(execRaw).not.toHaveBeenCalled();
    expect(ensureMutatingAllowed).not.toHaveBeenCalled();
    expect(res.requestId).toBe('r2');
    expect(res.rows).toEqual([{ a: 1 }]);
    expect(res.error).toBeUndefined();
    expect(res.elapsedMs).toBeTypeOf('number');
  });
});

