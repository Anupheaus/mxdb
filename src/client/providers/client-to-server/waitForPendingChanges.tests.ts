import { describe, it, expect } from 'vitest';
import { waitForPendingChanges } from './waitForPendingChanges';

/**
 * A local write resolves before the server has it, so anything that asks the server to read what was just written has
 * to wait for the queue to drain first. `isSynchronising` cannot answer that — it is false both before the dispatcher
 * picks a change up and after it has sent one — so this waits on the pending state itself, and gives up rather than
 * hanging a caller whose change can never be sent.
 */

interface Harness {
  listeners: Array<(isSyncing: boolean) => void>;
  unsubscribeCount: number;
  onSyncStateChanged(listener: (isSyncing: boolean) => void): () => void;
  /** Fires the dispatcher-changed event every listener is waiting on. */
  fire(): void;
}

function harness(): Harness {
  const self: Harness = {
    listeners: [],
    unsubscribeCount: 0,
    onSyncStateChanged(listener) {
      self.listeners.push(listener);
      return () => { self.unsubscribeCount += 1; };
    },
    fire() {
      self.listeners.forEach(listener => listener(false));
    },
  };
  return self;
}

describe('waitForPendingChanges', () => {
  it('resolves at once when nothing is pending', async () => {
    const { onSyncStateChanged } = harness();

    expect(await waitForPendingChanges({ hasPendingChanges: async () => false, onSyncStateChanged })).toBe(true);
  });

  it('waits for the queue to drain, then resolves', async () => {
    const events = harness();
    let isPending = true;

    const waiting = waitForPendingChanges({ hasPendingChanges: async () => isPending, onSyncStateChanged: events.onSyncStateChanged });
    await Promise.resolve();
    isPending = false;
    events.fire();

    expect(await waiting).toBe(true);
  });

  it('ignores a sync event while something is still pending', async () => {
    const events = harness();
    let checks = 0;

    const waiting = waitForPendingChanges({
      hasPendingChanges: async () => { checks += 1; return checks < 3; },
      onSyncStateChanged: events.onSyncStateChanged,
    });
    events.fire();
    await Promise.resolve();
    events.fire();

    expect(await waiting).toBe(true);
    expect(checks).toBeGreaterThanOrEqual(3);
  });

  it('gives up rather than hanging when the change can never be sent', async () => {
    const events = harness();

    expect(await waitForPendingChanges({ hasPendingChanges: async () => true, onSyncStateChanged: events.onSyncStateChanged, timeoutMs: 10 })).toBe(false);
  });

  it('lets the caller get on when the pending state cannot be read', async () => {
    const events = harness();

    expect(await waitForPendingChanges({
      hasPendingChanges: async () => { throw new Error('worker gone'); },
      onSyncStateChanged: events.onSyncStateChanged,
      timeoutMs: 10,
    })).toBe(true);
  });

  it('unsubscribes once settled, whichever way it settled', async () => {
    const drained = harness();
    await waitForPendingChanges({ hasPendingChanges: async () => false, onSyncStateChanged: drained.onSyncStateChanged });
    expect(drained.unsubscribeCount).toBe(1);

    const timedOut = harness();
    await waitForPendingChanges({ hasPendingChanges: async () => true, onSyncStateChanged: timedOut.onSyncStateChanged, timeoutMs: 10 });
    expect(timedOut.unsubscribeCount).toBe(1);
  });

  it('settles once even when the queue drains and the timeout fires together', async () => {
    const events = harness();
    let resolveCount = 0;

    const waiting = waitForPendingChanges({ hasPendingChanges: async () => false, onSyncStateChanged: events.onSyncStateChanged, timeoutMs: 1 })
      .then(result => { resolveCount += 1; return result; });
    events.fire();
    events.fire();

    expect(await waiting).toBe(true);
    expect(resolveCount).toBe(1);
  });
});
