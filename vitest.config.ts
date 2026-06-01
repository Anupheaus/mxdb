import { defineConfig } from 'vitest/config';
import path from 'path';
import fs from 'fs';

const localAlias = (relDir: string, ...parts: string[]) => {
  // Try relative to this config file first (works in the main repo).
  // Then fall back to C:/code/personal/<package>/<subdir> so git worktrees
  // (which live at .worktrees/<branch>/) also resolve correctly.
  const relative = path.resolve(__dirname, relDir);
  if (fs.existsSync(relative)) return path.resolve(relative, ...parts);
  // e.g. relDir = '../react-ui/src' → package = 'react-ui', subdir = 'src'
  const segments = relDir.replace(/^\.\.\//, '').split('/');
  const absolute = path.resolve('C:/code/personal', ...segments);
  return fs.existsSync(absolute) ? path.resolve(absolute, ...parts) : undefined;
};

const alias: Record<string, string> = {
  // One React instance for react-dom + linked react-ui (avoids invalid hook calls in tests).
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
const reactUiSrc = localAlias('../react-ui/src');
if (reactUiSrc) alias['@anupheaus/react-ui'] = reactUiSrc;

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    include: [
      'src/**/*.tests.ts',
      'src/**/*.tests.tsx',
      '*.unit.tests.ts',
      '*.unit.tests.tsx',
      '**/*.unit.tests.ts',
      '**/*.unit.tests.tsx',
    ],
    globals: true,
    setupFiles: ['./tests/e2e/setup/e2eVitestSetup.ts', './tests/e2e/setup/vitestGlobals.ts'],
    // css:true instructs Vitest to handle CSS imports (returning empty modules) rather than
    // throwing ERR_UNKNOWN_FILE_EXTENSION when @anupheaus/react-ui transitively pulls in
    // @uiw/react-md-editor which imports .css files.
    css: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.tests.ts', 'src/**/*.tests.tsx', 'src/**/*.d.ts'],
    },
  },
});
