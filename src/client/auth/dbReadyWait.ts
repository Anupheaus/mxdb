export interface DbReadyWaitHandle {
  setIsDbReady(ready: boolean): void;
  getIsDbReady(): boolean;
  waitForDbReady(): Promise<boolean>;
}

/** Promise-based wait until the local DB is ready, with a timeout fallback. */
export function createDbReadyWaitHandle(timeoutMs: number): DbReadyWaitHandle {
  let isDbReady = false;
  const waiters: Array<() => void> = [];

  return {
    getIsDbReady: () => isDbReady,
    setIsDbReady(ready: boolean) {
      isDbReady = ready;
      if (!ready) return;
      const pending = waiters.splice(0);
      for (const notify of pending) notify();
    },
    waitForDbReady() {
      if (isDbReady) return Promise.resolve(true);
      return new Promise<boolean>(resolve => {
        let timer: ReturnType<typeof setTimeout>;
        const notify = () => {
          clearTimeout(timer);
          removeWaiter(notify);
          resolve(true);
        };
        timer = setTimeout(() => {
          removeWaiter(notify);
          resolve(false);
        }, timeoutMs);
        waiters.push(notify);
      });
    },
  };

  function removeWaiter(notify: () => void) {
    const index = waiters.indexOf(notify);
    if (index >= 0) waiters.splice(index, 1);
  }
}
