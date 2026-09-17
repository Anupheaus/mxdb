import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useDb } from './DbContext';
import { withDb } from './withDb';
import type { ServerDb } from './ServerDb';

// `useLogger()` resolves via `Logger.getCurrent()`, which throws when `window` is defined — and
// this repo's vitest setup installs a JSDOM `window` globally for every test. Mock it the same way
// `seedCollections.tests.ts` does, rather than depending on ambient Logger ALS context.
const mockUseLogger = vi.fn();
vi.mock('@anupheaus/common', async importOriginal => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    useLogger: () => mockUseLogger(),
  };
});

describe('withDb', () => {
  const mockCreateSubLogger = vi.fn();
  const mockLogger = { createSubLogger: mockCreateSubLogger };
  mockCreateSubLogger.mockReturnValue(mockLogger);

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLogger.mockReturnValue(mockLogger);
    mockCreateSubLogger.mockReturnValue(mockLogger);
  });

  it('scopes the ambient db to the supplied ServerDb for the duration of the delegate', () => {
    const fake = { marker: 'scoped-db' } as unknown as ServerDb;
    const inside = withDb(fake, () => useDb());
    expect(inside).toBe(fake);
  });
});
