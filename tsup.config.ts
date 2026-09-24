import { defineConfig } from 'tsup';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// The SQLite workers are started from the client bundle with
// `new Worker(new URL('./sqlite-worker.ts', import.meta.url), { type: 'module' })`
// (see src/client/db-worker/SqliteWorkerClient.ts). esbuild/tsup does NOT bundle or emit those worker
// references — it passes the `./sqlite-worker.ts` URL through verbatim — so the CONSUMER's bundler must
// compile the worker from that source. That only worked when a consumer aliased `@anupheaus/mxdb/client`
// to THIS repo's src (dev mode); a production build resolving from the published `dist` failed with
// "Can't resolve './sqlite-worker.ts'" because the worker source was never shipped.
//
// Fix: ship the worker source files at the dist root (where `client.js`'s `./…` URLs resolve), so the
// same `.ts` references resolve from the published package too. Their only local dependency is each
// other (`worker-messages` is type-only; `sqlite-worker-shared` is a value import); the npm deps
// (@sqlite.org/sqlite-wasm, ulidx) resolve from the consumer, exactly as in the dev build. Nothing in
// this set imports outside db-worker at runtime, so a flat copy to dist is self-contained.
const WORKER_SRC_DIR = 'src/client/db-worker';
const WORKER_FILES = [
  'sqlite-worker.ts',
  'sqlite-shared-worker.ts',
  'sqlite-worker-shared.ts',
  'worker-messages.ts',
];

export default defineConfig({
  entry: {
    client: 'src/client/index.ts',
    server: 'src/server/index.ts',
    common: 'src/common/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  target: 'es2022',
  // Runs after a successful build (dist already written by then); copies the worker sources in.
  async onSuccess() {
    await mkdir('dist', { recursive: true });
    await Promise.all(
      WORKER_FILES.map(file => copyFile(join(WORKER_SRC_DIR, file), join('dist', file))),
    );
  },
});
