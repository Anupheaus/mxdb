/**
 * The SQLite worker source files `tsup.config.ts` ships, flat, at the root of the published `dist`.
 *
 * The client starts the workers with `new Worker(new URL('./sqlite-worker.ts', import.meta.url))`, which tsup does
 * not bundle: the CONSUMER's bundler compiles the worker from these shipped sources. So every file a worker imports
 * (by a relative path) must be in this list, or every consumer build fails with "Can't resolve" — as 0.2.1 did when
 * `encryptedFlushScheduler.ts` was added without being listed. `worker-files.tests.ts` guards that.
 */
export const WORKER_FILES = [
  'sqlite-worker.ts',
  'sqlite-shared-worker.ts',
  'sqlite-worker-shared.ts',
  'worker-messages.ts',
  'encryptedFlushScheduler.ts',
];
