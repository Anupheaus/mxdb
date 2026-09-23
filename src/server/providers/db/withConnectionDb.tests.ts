import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useDb } from './DbContext';
import { createConnectionDbPool } from './connectionDbRouter';
import { setConnectionDbPool, withConnectionDb } from './withConnectionDb';
import type { ServerDb } from './ServerDb';
import type { ConnectionDbTarget } from '../../internalModels';

// `withDb` resolves `useLogger()` via `Logger.getCurrent()`, which throws under this repo's global
// JSDOM `window` — mock it as `withDb.tests.ts` does.
const mockUseLogger = vi.fn();
vi.mock('@anupheaus/common', async importOriginal => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    useLogger: () => mockUseLogger(),
  };
});

function makeTarget(overrides: Partial<ConnectionDbTarget> = {}): ConnectionDbTarget {
  return { dbName: 'tenant-a', mongoDbUrl: 'mongodb://cluster-a', ...overrides };
}

function makeFakeServerDb(target: ConnectionDbTarget): ServerDb {
  return { marker: `${target.mongoDbUrl}/${target.dbName}` } as unknown as ServerDb;
}

describe('withConnectionDb', () => {
  const mockLogger = { createSubLogger: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger.createSubLogger.mockReturnValue(mockLogger);
    mockUseLogger.mockReturnValue(mockLogger);
  });

  it('scopes the ambient db to the pooled ServerDb for the target', () => {
    const pool = createConnectionDbPool(makeFakeServerDb);
    setConnectionDbPool(pool);
    const target = makeTarget();

    const inside = withConnectionDb(target, () => useDb());

    expect(inside).toBe(pool.getOrCreate(target));
  });

  it('reuses the same pooled ServerDb a routed connection to the same database gets', () => {
    const pool = createConnectionDbPool(makeFakeServerDb);
    setConnectionDbPool(pool);
    const connectionDb = pool.getOrCreate(makeTarget());

    const inside = withConnectionDb(makeTarget(), () => useDb());

    expect(inside).toBe(connectionDb);
  });

  it('routes different targets to different databases', () => {
    setConnectionDbPool(createConnectionDbPool(makeFakeServerDb));

    const first = withConnectionDb(makeTarget({ dbName: 'tenant-a' }), () => useDb());
    const second = withConnectionDb(makeTarget({ dbName: 'tenant-b' }), () => useDb());

    expect(first).not.toBe(second);
  });

  it('throws before startServer has registered the pool', async () => {
    vi.resetModules();
    const { withConnectionDb: freshWithConnectionDb } = await import('./withConnectionDb');
    const delegate = vi.fn();

    expect(() => freshWithConnectionDb(makeTarget(), delegate)).toThrow('The connection database pool has not been initialised');
    expect(delegate).not.toHaveBeenCalled();
  });

  it('returns the delegate result', () => {
    setConnectionDbPool(createConnectionDbPool(makeFakeServerDb));

    expect(withConnectionDb(makeTarget(), () => 42)).toBe(42);
  });
});
