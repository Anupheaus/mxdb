import path from 'path';

/**
 * `NODE_EXTRA_CA_CERTS` + `NODE_OPTIONS --require preload-tls` for Vitest workers connecting to
 * the e2e HTTPS server (`wss://localhost`) without shell `cross-env`.
 *
 * @param projectRoot Directory that contains `tests/e2e/setup/` (usually `__dirname` of `vitest.*.config.ts` at repo root).
 */
export function vitestE2eTlsEnv(projectRoot: string): Record<string, string> {
  const preload = path.resolve(projectRoot, 'tests/e2e/setup/preload-tls.cjs');
  const ca = path.resolve(projectRoot, 'tests/e2e/setup/certs/ca.crt');
  return {
    NODE_EXTRA_CA_CERTS: ca,
    NODE_OPTIONS: `--require=${preload}`,
  };
}
