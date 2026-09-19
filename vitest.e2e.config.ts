import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';
import fs from 'fs';
import { vitestE2eTlsEnv } from './tests/e2e/setup/vitestTlsEnv';

// @mui v5 packages have no `exports` map, so a bare subpath that points at a directory (e.g.
// `@mui/utils/formatMuiErrorMessage`, imported by the inlined `@mui/material/styles/index.js`) does not
// resolve to a file. Vite leaves such an unresolved bare import external, and Node then rejects the
// directory import (ERR_UNSUPPORTED_DIR_IMPORT). This resolver rewrites any extensionless `@mui/*`
// subpath to its `/index.js` so it resolves to a real file (whether it ends up inlined or externalised).
interface ResolvePluginContext {
  resolve(
    source: string,
    importer: string | undefined,
    options: { skipSelf: boolean },
  ): Promise<{ id: string } | null>;
}
const muiDirectoryImportPlugin = {
  name: 'mui-directory-import-fix',
  enforce: 'pre' as const,
  async resolveId(this: ResolvePluginContext, source: string, importer: string | undefined) {
    // Only bare @mui subpaths with at least a package + one segment, and no explicit file extension.
    if (!/^@mui\/[^/]+\/.+/.test(source) || /\.[cm]?[jt]sx?$|\.json$/.test(source)) return null;
    const resolved = await this.resolve(`${source}/index.js`, importer, { skipSelf: true });
    if (process.env.CI && /formatMuiErrorMessage/.test(source)) {
      // eslint-disable-next-line no-console
      console.error('[DIAG-RESOLVE]', source, '->', resolved ? resolved.id.replace(/.*node_modules\//, '') : 'NULL', '| importer:', importer?.replace(/.*node_modules\//, '') ?? 'none');
    }
    return resolved ? resolved.id : null;
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
    plugins: [muiDirectoryImportPlugin],
    resolve: sharedResolve,
    test: {
      env: vitestE2eTlsEnv(__dirname),
      pool: 'forks',
      // Use Node (not Vitest's jsdom env) so engine.io-client uses the `ws` package, which
      // respects preload-tls.cjs for wss:// to the self-signed e2e HTTPS server. Browser
      // globals come from installBrowserEnvironment() in vitestGlobals.ts.
      environment: 'node',
      // Inline react-ui + its MUI/emotion/uiw deps so Vite transforms them (resolving @mui v5's bare
      // subpath directory imports and CSS) instead of handing the ESM dist to Node's loader.
      server: { deps: { inline: [/@anupheaus\/react-ui/, /@mui\//, /@emotion\//, /@uiw\//] } },
      // Handle react-ui's transitive CSS imports (via @uiw/react-md-editor) the same way the unit config does.
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
