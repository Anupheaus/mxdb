import { describe, it, expect, vi, beforeEach } from 'vitest';
import { seedCollections } from './seedCollections';
import { defineCollection } from '../../common/defineCollection';
import { extendCollection } from '../collections/extendCollection';

const mockLoadSeededData = vi.fn();
const mockSaveSeededData = vi.fn();
const mockUseCollection = vi.fn();
const mockUseLogger = vi.fn();

vi.mock('./seededData', () => ({
  loadSeededData: () => mockLoadSeededData(),
  saveSeededData: (data: Record<string, string>) => mockSaveSeededData(data),
}));
vi.mock('../collections', () => ({ useCollection: (c: unknown) => mockUseCollection(c) }));
vi.mock('@anupheaus/common', async importOriginal => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    useLogger: () => mockUseLogger(),
  };
});

describe('seedCollections', () => {
  const mockInfo = vi.fn();
  const mockDebug = vi.fn();
  const mockSilly = vi.fn();
  const mockCreateSubLogger = vi.fn();
  const mockLogger = {
    info: mockInfo,
    debug: mockDebug,
    silly: mockSilly,
    createSubLogger: mockCreateSubLogger,
  };
  mockCreateSubLogger.mockReturnValue(mockLogger);

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSeededData.mockReturnValue({});
    mockUseLogger.mockReturnValue(mockLogger);
  });

  it('loads and saves seeded data', async () => {
    const collection = defineCollection({ name: 'items', indexes: [] });
    extendCollection(collection, { onSeed: async () => {} });
    mockUseCollection.mockReturnValue({ getAll: vi.fn().mockResolvedValue([]), upsert: vi.fn(), remove: vi.fn() });

    await seedCollections([collection]);

    expect(mockLoadSeededData).toHaveBeenCalled();
    expect(mockSaveSeededData).toHaveBeenCalled();
  });

  it('skips collections without onSeed', async () => {
    const collection = defineCollection({ name: 'items', indexes: [] });
    await seedCollections([collection]);
    expect(mockUseCollection).not.toHaveBeenCalled();
  });

  it('calls onSeed with seedWith when extension has onSeed', async () => {
    const collection = defineCollection({ name: 'items', indexes: [] });
    const onSeed = vi.fn();
    extendCollection(collection, { onSeed });
    const getAll = vi.fn().mockResolvedValue([]);
    const upsert = vi.fn();
    const remove = vi.fn();
    mockUseCollection.mockReturnValue({ getAll, upsert, remove });

    await seedCollections([collection]);

    expect(onSeed).toHaveBeenCalledTimes(1);
    expect(typeof onSeed.mock.calls[0]![0]).toBe('function');
  });
});
