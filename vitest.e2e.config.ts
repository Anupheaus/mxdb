import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';
import fs from 'fs';
import { vitestE2eTlsEnv } from './tests/e2e/setup/vitestTlsEnv';

// Minimal shape of the esbuild plugin build API we use (avoids importing esbuild's types, which are
// only transitively installed). Stubs CSS to empty modules during the SSR dep prebundle (see
// deps.optimizer.ssr below).
interface EsbuildBuild {
  onLoad(options: { filter: RegExp }, callback: () => { contents: string; loader: 'js' }): void;
}
const esbuildCssStubPlugin = {
  name: 'stub-css',
  setup(build: EsbuildBuild) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
  },
};

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
    resolve: sharedResolve,
    test: {
      env: vitestE2eTlsEnv(__dirname),
      pool: 'forks',
      // Use Node (not Vitest's jsdom env) so engine.io-client uses the `ws` package, which
      // respects preload-tls.cjs for wss:// to the self-signed e2e HTTPS server. Browser
      // globals come from installBrowserEnvironment() in vitestGlobals.ts.
      environment: 'node',
      // react-ui ships an ESM dist that externalises @mui v5, whose bare subpath imports (e.g.
      // `@mui/material/styles` → `@mui/utils/formatMuiErrorMessage`) are directory imports Node's ESM
      // loader rejects with ERR_UNSUPPORTED_DIR_IMPORT. `server.deps.inline` should make Vite transform
      // them, but on Linux CI (in this e2e context) react-ui's node_modules dist was still externalised
      // and reached Node's loader. So in CI we ALSO esbuild-prebundle react-ui + its MUI/emotion deps via
      // deps.optimizer.ssr: esbuild is a bundler and resolves those directory imports at bundle time,
      // regardless of the SSR externalisation heuristics. Gated to CI (no sibling react-ui src) because
      // the SSR optimizer trips ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows; locally react-ui is aliased to
      // sibling src and transformed directly, so the optimizer is not needed.
      deps: reactUiSrc
        ? undefined
        : {
          optimizer: {
            ssr: {
              enabled: true,
              // Vite's SSR optimizer only bundles the packages listed here and externalises everything
              // else, so every dep in react-ui's chain that has a problematic import (a @mui v5 directory
              // import, or a .css import) must be listed explicitly. @uiw/* ship the .css stubbed below.
              include: [
                '@anupheaus/react-ui', '@mui/material', '@mui/x-date-pickers', '@emotion/react', '@emotion/styled',
                '@uiw/react-md-editor', '@uiw/react-markdown-preview',
              ],
              // esbuild bundles react-ui's transitive .css imports (via @uiw/react-md-editor) too; stub
              // them to empty modules so the prebundle doesn't emit CSS that Node can't load
              // (ERR_UNKNOWN_FILE_EXTENSION). Mirrors the `css: true` handling for Vite's own pipeline.
              esbuildOptions: { plugins: [esbuildCssStubPlugin] },
            },
          },
        },
      server: { deps: { inline: [/@anupheaus\/react-ui/, /@mui\//, /@emotion\//, /@uiw\//] } },
      // Handle react-ui's transitive CSS imports (via @uiw/react-md-editor) the same way the unit
      // config does. `css: true` (Vitest returns empty modules for CSS) — NOT a custom stub plugin —
      // is required for react-ui to stay inlined on Linux CI; with a plugin-based .css stub instead,
      // Vite externalised react-ui's ESM dist and its @mui subpaths hit Node's loader (dir-import error).
      css: true,
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
