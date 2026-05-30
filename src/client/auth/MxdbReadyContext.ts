import { createContext } from 'react';

export const DB_READY_TIMEOUT_MS = 3_000;

export interface MxdbReadyContextProps {
  /** Resolves when the local DB encryption key is available, or after {@link DB_READY_TIMEOUT_MS}. */
  waitForDbReady(): Promise<boolean>;
  /** Reads current DB-ready state — safe inside stale closures. */
  getIsDbReady(): boolean;
}

export const MxdbReadyContext = createContext<MxdbReadyContextProps>({
  waitForDbReady: () => Promise.resolve(false),
  getIsDbReady: () => false,
});
