import path from 'path';
import { pathToFileURL } from 'url';

/**
 * Env for Vitest workers connecting to the e2e HTTPS server (`wss://localhost`): `NODE_EXTRA_CA_CERTS`
 * to trust the e2e CA, and `MXDB_ESM_COMPAT_LOADER` (a file URL) that `tlsSetup.ts` registers as a Node
 * ESM customisation loader. No shell `cross-env` / NODE_OPTIONS required.
 *
 * @param projectRoot Directory that contains `tests/e2e/setup/` (usually `__dirname` of `vitest.*.config.ts` at repo root).
 */
export function vitestE2eTlsEnv(projectRoot: string): Record<string, string> {
  const ca = path.resolve(projectRoot, 'tests/e2e/setup/certs/ca.crt');
  const esmCompatLoader = pathToFileURL(path.resolve(projectRoot, 'tests/e2e/setup/nodeEsmCompat.mjs')).href;
  // The tls.connect patch and the Node ESM compat hooks are registered by the `tlsSetup.ts` setupFile
  // (which reads MXDB_ESM_COMPAT_LOADER), so no NODE_OPTIONS `--require`/`--import` is needed.
  return {
    NODE_EXTRA_CA_CERTS: ca,
    MXDB_ESM_COMPAT_LOADER: esmCompatLoader,
  };
}
