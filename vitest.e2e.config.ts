import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';
import fs from 'fs';
import { vitestE2eTlsEnv } from './tests/e2e/setup/vitestTlsEnv';

const localAlias = (relDir: string) => {
  const relative = path.resolve(__dirname, relDir);
  if (fs.existsSync(relative)) return relative;
  // Fallback for git worktrees where __dirname is .worktrees/<branch>/
  const segments = relDir.replace(/^\.\.\//, '').split('/');
  const absolute = path.resolve('C:/code/personal', ...segments);
  return fs.existsSync(absolute) ? absolute : undefined;
};

const alias: Record<string, string> = {
  react: path.resolve(__dirname, 'node_modules/react'),
  'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
};

const socketApiSrc = localAlias('../nexus/src');
if (socketApiSrc) {
  alias['@anupheaus/nexus/server'] = path.join(socketApiSrc, 'server');
  alias['@anupheaus/nexus/client'] = path.join(socketApiSrc, 'client');
  alias['@anupheaus/nexus/common'] = path.join(socketApiSrc, 'common');
}
const commonSrc = localAlias('../common/src');
if (commonSrc) alias['@anupheaus/common'] = commonSrc;
// Alias react-ui to its sibling SOURCE when present (local/dev) so Vite transforms it. In CI there is
// no sibling, so it resolves to the node_modules ESM dist and is inlined instead (see server.deps.inline).
const reactUiSrc = localAlias('../react-ui/src');
if (reactUiSrc) alias['@anupheaus/react-ui'] = reactUiSrc;

const sharedResolve = { alias };

/**
 * One Vitest config for all browser e2e tests. Modes:
 *   --mode crud        CRUD e2e tests (`tests/e2e/crud-operations/**\/*.crud.e2e.tests.ts`)
 *   --mode performance Performance e2e tests (`tests/e2e/crud-operations/performance.e2e.tests.ts`)
 *   --mode stress      Stress tests (`tests/e2e/stress/**\/*.tests.ts`)
 *
 * Forked workers read NODE_OPTIONS at startup (TLS preload + trust e2e CA).
 */
const cssStubPlugin = {
  name: 'stub-css',
  transform(_code: string, id: string) {
    if (id.endsWith('.css')) return 'export default {}';
  },
};

export default defineConfig(({ mode }) => {
  const isCrud = mode === 'crud';
  const isPerformance = mode === 'performance';
  const isStress = mode === 'stress';

  const crudInclude = ['tests/e2e/crud-operations/**/*.crud.e2e.tests.ts'];
  const performanceInclude = ['tests/e2e/crud-operations/performance.e2e.tests.ts'];
  const stressInclude = ['tests/e2e/stress/**/*.tests.ts'];

  const crudExclude = [...configDefaults.exclude, 'tests/**/*.unit.tests.ts', 'tests/**/*.unit.tests.tsx'];
  const performanceExclude = [...configDefaults.exclude, 'tests/**/*.unit.tests.ts', 'tests/**/*.unit.tests.tsx'];
  const stressExclude = [...configDefaults.exclude, 'tests/e2e/stress/**/*.unit.tests.ts', 'tests/e2e/stress/**/*.unit.tests.tsx'];

  const include = isCrud ? crudInclude : isPerformance ? performanceInclude : stressInclude;
  const exclude = isCrud ? crudExclude : isPerformance ? performanceExclude : stressExclude;
  const testTimeout = isStress ? 300_000 : 120_000;

  return {
    plugins: [cssStubPlugin],
    resolve: sharedResolve,
    test: {
      env: vitestE2eTlsEnv(__dirname),
      // The `threads` pool (Vitest 1.x default) — NOT `forks`. In the forks pool on Linux CI,
      // `server.deps.inline` below did not reliably transform react-ui's node_modules ESM dist, so its
      // externalised @mui v5 subpath imports reached Node's ESM loader and threw ERR_UNSUPPORTED_DIR_IMPORT
      // (e.g. `@mui/material/styles` → `@mui/utils/formatMuiErrorMessage`). The thread pool inlines them
      // correctly — the same mechanism the unit config relies on in CI. TLS trust for wss:// still applies
      // via `env` above (NODE_EXTRA_CA_CERTS + preload-tls), verified against the self-signed e2e server.
      pool: 'threads',
      // Run all e2e files sequentially in one worker (like the former single-fork isolation) so they
      // don't contend over the shared MongoDB/HTTPS e2e server; the thread pool still inlines correctly.
      poolOptions: { threads: { singleThread: true } },
      // Use Node (not Vitest's jsdom env) so engine.io-client uses the `ws` package, which
      // respects preload-tls.cjs for wss:// to the self-signed e2e HTTPS server. Browser
      // globals come from installBrowserEnvironment() in vitestGlobals.ts.
      environment: 'node',
      // Inlining react-ui + its MUI/emotion/uiw deps makes Vite transform them so their @mui v5 bare
      // subpath imports resolve at bundle time instead of hitting Node's ESM loader (see pool note above).
      server: { deps: { inline: [/@anupheaus\/react-ui/, /@mui\//, /@emotion\//, /@uiw\//] } },
      include,
      exclude,
      testTimeout,
      globals: true,
      globalSetup: ['./tests/e2e/setup/e2eGlobalSetup.ts'],
      setupFiles: ['./tests/e2e/setup/e2eVitestSetup.ts', './tests/e2e/setup/vitestGlobals.ts'],
      dangerouslyIgnoreUnhandledErrors: true,
    },
  };
});
