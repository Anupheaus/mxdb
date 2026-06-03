import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReconcileRequest } from '../../common/models';

const mockUseDb = vi.fn();
const mockUseLogger = vi.fn();
const mockUseServerToClientSynchronisation = vi.fn();

vi.mock('../providers', () => ({
  useDb: () => mockUseDb(),
  useServerToClientSynchronisation: () => mockUseServerToClientSynchronisation(),
}));

vi.mock('@anupheaus/nexus/server', () => ({
  createServerActionHandler: (_def: unknown, handler: unknown) => handler,
  useLogger: () => mockUseLogger(),
}));

import { handleReconcile } from './reconcileAction';

describe('handleReconcile', () => {
  const mockGet = vi.fn();
  const mockPushDeletes = vi.fn();
  let mockWarn: ReturnType<typeof vi.fn>;
  let mockDebug: ReturnType<typeof vi.fn>;
  let mockError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(undefined);
    mockPushDeletes.mockResolvedValue(undefined);
    mockWarn = vi.fn();
    mockDebug = vi.fn();
    mockError = vi.fn();
    mockUseDb.mockReturnValue({ use: () => ({ get: mockGet }) });
    mockUseServerToClientSynchronisation.mockReturnValue({ pushDeletes: mockPushDeletes });
    mockUseLogger.mockReturnValue({
      warn: mockWarn,
      debug: mockDebug,
      error: mockError,
      info: vi.fn(),
      silly: vi.fn(),
      createSubLogger: vi.fn(),
    });
  });

  it('returns empty response for empty request', async () => {
    const result = await handleReconcile([]);
    expect(result).toEqual([]);
  });

  it('skips items with empty localIds and makes no get calls', async () => {
    const request: ReconcileRequest = [{ collectionName: 'items', localIds: [] }];
    const result = await handleReconcile(request);
    expect(mockGet).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('reports deleted ids for records not found on server', async () => {
    mockGet.mockResolvedValue(undefined);
    const request: ReconcileRequest = [{ collectionName: 'items', localIds: ['id-1', 'id-2'] }];
    const result = await handleReconcile(request);
    expect(result).toEqual([{ collectionName: 'items', deletedIds: ['id-1', 'id-2'] }]);
  });

  it('does not report ids that exist on server', async () => {
    // 'id-1' exists, 'id-2' does not
    mockGet.mockImplementation(async (id: string) => (id === 'id-1' ? { id: 'id-1' } : undefined));
    const request: ReconcileRequest = [{ collectionName: 'items', localIds: ['id-1', 'id-2'] }];
    const result = await handleReconcile(request);
    expect(result).toEqual([{ collectionName: 'items', deletedIds: ['id-2'] }]);
  });

  it('calls pushDeletes for deleted ids', async () => {
    mockGet.mockResolvedValue(undefined);
    const request: ReconcileRequest = [{ collectionName: 'items', localIds: ['id-1', 'id-2'] }];
    await handleReconcile(request);
    expect(mockPushDeletes).toHaveBeenCalledWith('items', ['id-1', 'id-2']);
  });

  it('does NOT call pushDeletes when all records exist', async () => {
    mockGet.mockImplementation(async (id: string) => ({ id }));
    const request: ReconcileRequest = [{ collectionName: 'items', localIds: ['id-1', 'id-2'] }];
    await handleReconcile(request);
    expect(mockPushDeletes).not.toHaveBeenCalled();
  });

  it('skips unknown collection and logs a warning when db.use throws', async () => {
    mockUseDb.mockReturnValue({
      use: () => {
        throw new Error('Unknown collection');
      },
    });
    const request: ReconcileRequest = [{ collectionName: 'unknown', localIds: ['id-1'] }];
    const result = await handleReconcile(request);
    expect(result).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith('Reconcile: unknown collection "unknown" — skipping');
  });

  it('handles multiple collections in a single request', async () => {
    // 'alpha': id-1 missing, id-2 exists; 'beta': all missing
    mockGet.mockImplementation(async (id: string) => (id === 'id-2' ? { id: 'id-2' } : undefined));
    const request: ReconcileRequest = [
      { collectionName: 'alpha', localIds: ['id-1', 'id-2'] },
      { collectionName: 'beta', localIds: ['id-3'] },
    ];
    const result = await handleReconcile(request);
    expect(result).toEqual([
      { collectionName: 'alpha', deletedIds: ['id-1'] },
      { collectionName: 'beta', deletedIds: ['id-3'] },
    ]);
    expect(mockPushDeletes).toHaveBeenCalledWith('alpha', ['id-1']);
    expect(mockPushDeletes).toHaveBeenCalledWith('beta', ['id-3']);
  });

  it('logs an error if pushDeletes rejects (fire-and-forget)', async () => {
    const pushError = new Error('push failed');
    mockPushDeletes.mockRejectedValue(pushError);
    mockGet.mockResolvedValue(undefined);
    const request: ReconcileRequest = [{ collectionName: 'items', localIds: ['id-1'] }];
    await handleReconcile(request);
    // Let the fire-and-forget promise settle
    await new Promise(r => setTimeout(r, 0));
    expect(mockError).toHaveBeenCalledWith(
      'Reconcile: pushDeletes failed for "items"',
      { error: pushError },
    );
  });
});
