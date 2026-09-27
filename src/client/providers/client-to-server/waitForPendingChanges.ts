/** How long to wait for pending changes to reach the server before giving up. */
export const PENDING_CHANGES_TIMEOUT_MS = 10_000;

export interface WaitForPendingChangesProps {
  /** Whether anything is still waiting to be sent to the server. */
  hasPendingChanges(): Promise<boolean>;
  /** Subscribes to the dispatcher starting and finishing; returns its unsubscribe. */
  onSyncStateChanged(listener: (isSyncing: boolean) => void): () => void;
  /** Overrides {@link PENDING_CHANGES_TIMEOUT_MS}; for tests. */
  timeoutMs?: number;
}

/**
 * Resolves true once nothing is waiting to be sent to the server, or false if that has not happened within
 * `timeoutMs`.
 *
 * Why a promise and not `isSynchronising`: that flag is false both BEFORE the dispatcher picks up a fresh change and
 * after it has sent one, so code that awaits it passes straight through while the change is still only local.
 *
 * Why it resolves false rather than rejecting or waiting for ever: a client that is offline, or whose change the server
 * keeps refusing, would otherwise hang its caller indefinitely. Callers decide what to do about it. Genuine sync
 * failures surface through `MXDBSync`'s `onSyncRejected` / `onError`, not here.
 */
export function waitForPendingChanges({ hasPendingChanges, onSyncStateChanged, timeoutMs = PENDING_CHANGES_TIMEOUT_MS }: WaitForPendingChangesProps): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let isSettled = false;
    // Collected rather than referenced directly, so `settle` needs no forward reference to them.
    const cleanups: Array<() => void> = [];

    const settle = (isSynchronised: boolean) => {
      if (isSettled) return;
      isSettled = true;
      cleanups.forEach(cleanup => cleanup());
      resolve(isSynchronised);
    };

    const check = async () => {
      try {
        if (!(await hasPendingChanges())) settle(true);
      } catch {
        // The pending state could not be read; let the caller get on rather than hanging it on a broken check.
        settle(true);
      }
    };

    const unsubscribe = onSyncStateChanged(() => { void check(); });
    cleanups.push(unsubscribe);
    const timer = setTimeout(() => settle(false), timeoutMs);
    cleanups.push(() => clearTimeout(timer));
    void check();
  });
}
