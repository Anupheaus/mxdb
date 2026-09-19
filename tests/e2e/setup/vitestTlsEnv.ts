import path from 'path';

/**
 * `NODE_EXTRA_CA_CERTS` + `NODE_OPTIONS --require preload-tls` for Vitest workers connecting to
 * the e2e HTTPS server (`wss://localhost`) without shell `cross-env`.
 *
 * @param projectRoot Directory that contains `tests/e2e/setup/` (usually `__dirname` of `vitest.*.config.ts` at repo root).
 */
export function vitestE2eTlsEnv(projectRoot: string): Record<string, string> {
  const ca = path.resolve(projectRoot, 'tests/e2e/setup/certs/ca.crt');
  // NB: the tls.connect rejectUnauthorized patch that used to live in a `--require=preload-tls.cjs`
  // preload now runs as the `tlsSetup.ts` setupFile instead. A `--require` NODE_OPTIONS preload runs
  // before vite-node initialises in each worker and made it externalise react-ui's ESM dist (whose @mui
  // v5 subpaths then hit Node's loader as directory imports). No NODE_OPTIONS here avoids that.
  return {
    NODE_EXTRA_CA_CERTS: ca,
  };
}
