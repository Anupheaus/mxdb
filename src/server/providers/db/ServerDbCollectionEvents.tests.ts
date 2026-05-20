import '@anupheaus/common';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ServerDbCollectionEvents } from './ServerDbCollectionEvents';
import type { ServerDbChangeEvent } from './server-db-models';

// The global e2eVitestSetup vi.mock('@anupheaus/common') strips the side-effect that installs
// Date.isIsoString, so dbUtils.deserialize would throw at runtime inside the debounce callback.
// These tests verify debouncing and batching behaviour only — not serialisation — so we mock the
// transform layer to remove the dependency on that side-effect entirely.
vi.mock('./db-transforms', () => ({
  dbUtils: {
    deserialize: vi.fn().mockImplementation((doc: Record<string, unknown> | undefined) => {
      if (doc == null) return undefined;
      const { _id, ...rest } = doc;
      return { ...rest, id: _id };
    }),
    serialize: vi.fn(),
  },
}));

describe('ServerDbCollectionEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches insert/update events and dispatches after debounce', async () => {
    const callbacks = new Set<(event: ServerDbChangeEvent) => void>();
    const cb = vi.fn();
    callbacks.add(cb);
    const onAfterDispatch = vi.fn();
    const events = new ServerDbCollectionEvents({
      collectionName: 'items',
      callbacks,
      operationType: 'insert',
      debounceMs: 50,
      onAfterDispatch,
    });

    events.process({
      operationType: 'insert',
      fullDocument: { _id: '1', name: 'a' },
    } as any);
    events.process({
      operationType: 'update',
      fullDocument: { _id: '2', name: 'b' },
    } as any);

    expect(cb).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(onAfterDispatch).toHaveBeenCalledTimes(1);
    expect(onAfterDispatch.mock.calls[0][0]).toMatchObject({
      collectionName: 'items',
      type: 'insert',
      records: expect.any(Array),
    });
    expect(onAfterDispatch.mock.calls[0][0].records).toHaveLength(2);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].records).toHaveLength(2);
  });

  it('batches delete events and dispatches after debounce', async () => {
    const callbacks = new Set<(event: ServerDbChangeEvent) => void>();
    const cb = vi.fn();
    callbacks.add(cb);
    const events = new ServerDbCollectionEvents({
      collectionName: 'items',
      callbacks,
      operationType: 'delete',
      debounceMs: 30,
    });

    events.process({ operationType: 'delete', documentKey: { _id: 'id1' } } as any);
    events.process({ operationType: 'delete', documentKey: { _id: 'id2' } } as any);

    await vi.advanceTimersByTimeAsync(30);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toEqual({
      collectionName: 'items',
      type: 'delete',
      recordIds: ['id1', 'id2'],
    });
  });

  it('resets timer when new event arrives within debounce window', async () => {
    const callbacks = new Set<(event: ServerDbChangeEvent) => void>();
    const cb = vi.fn();
    callbacks.add(cb);
    const events = new ServerDbCollectionEvents({
      collectionName: 'items',
      callbacks,
      operationType: 'insert',
      debounceMs: 100,
    });

    events.process({ operationType: 'insert', fullDocument: { _id: '1', name: 'a' } } as any);
    await vi.advanceTimersByTimeAsync(50);
    events.process({ operationType: 'insert', fullDocument: { _id: '2', name: 'b' } } as any);
    expect(cb).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(cb).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].records).toHaveLength(2);
  });
});
