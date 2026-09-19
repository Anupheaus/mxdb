import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';
import fs from 'fs';
import { vitestE2eTlsEnv } from './tests/e2e/setup/vitestTlsEnv';

// react-ui's transitive .css imports (via @uiw/react-md-editor) must be stubbed inside the SSR dep
// prebundle too (css:true only covers Vite's own transform). onResolve claims every .css into a private
// namespace so esbuild doesn't externalise it (an external .css would reach Node → ERR_UNKNOWN_FILE_EXTENSION).
interface EsbuildBuild {
  onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => { path: string; namespace: string }): void;
  onLoad(options: { filter: RegExp; namespace?: string }, callback: () => { contents: string; loader: 'js' }): void;
}
const esbuildCssStubPlugin = {
  name: 'stub-css',
  setup(build: EsbuildBuild) {
    build.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'css-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'css-stub' }, () => ({ contents: '', loader: 'js' }));
  },
};

// react-ui's runtime deps. Vite's SSR optimizer only bundles what's listed in include and externalises
// everything else, so react-ui plus ALL of its deps are prebundled by esbuild — which resolves @mui v5's
// directory subpaths, CJS/ESM interop (crypto-js, react-async-script, …) and (with the stub above) .css,
// none of which Node's own loader handles when react-ui's ESM dist is externalised.
const REACT_UI_OPTIMIZE_DEPS = [
  '@anupheaus/react-ui',
  '@emotion/react', '@emotion/styled',
  '@mui/material', '@mui/x-date-pickers', '@mui/utils', '@mui/system',
  '@uiw/react-md-editor', '@uiw/react-markdown-preview',
  'color', 'crypto-js', 'flatted', 'luxon', 'qr-code-styling',
  'react-hot-toast', 'react-icons', 'signature_pad', 'tss-react', 'use-resize-observer',
];

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
  // react-ui's RecaptchaWrapper calls react-async-script's default export (a HOC loader) at module load;
  // its CJS interop breaks under the e2e prebundle and reCAPTCHA isn't exercised by sync tests, so stub it.
  'react-async-script': path.resolve(__dirname, 'tests/e2e/setup/stubs/react-async-script.mjs'),
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
      // Use Node (not Vitest's jsdom env) so engine.io-client uses the `ws` package, which respects
      // preload-tls.cjs for wss:// to the self-signed e2e HTTPS server. Browser globals come from
      // installBrowserEnvironment() in vitestGlobals.ts.
      environment: 'node',
      // In CI (no sibling react-ui src) vite-node externalises react-ui's ESM dist at execution, so its
      // @mui v5 directory subpaths and CJS deps reach Node's loader and fail. esbuild-prebundle react-ui
      // and all its runtime deps so they're served as bundled ESM instead — esbuild resolves the directory
      // imports, CJS/ESM interop and (with the stub plugin) .css. Gated to CI because the SSR optimizer
      // trips ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows; locally react-ui is sibling src and transformed.
      deps: reactUiSrc
        ? undefined
        : { optimizer: { ssr: { enabled: true, include: REACT_UI_OPTIMIZE_DEPS, esbuildOptions: { plugins: [esbuildCssStubPlugin] } } } },
      // Also inline via Vite's own pipeline (used locally with sibling src, and a belt for CI).
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
