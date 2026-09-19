/**
 * Node ESM customisation hooks for the e2e run.
 *
 * When react-ui's published ESM dist is externalised by vite-node (handed to Node's native loader
 * rather than transformed by Vite), two things Node's ESM loader can't handle leak through:
 *   1. @mui v5 has no `exports` map, so bare subpaths that point at a directory (e.g.
 *      `@mui/utils/formatMuiErrorMessage`) throw ERR_UNSUPPORTED_DIR_IMPORT.
 *   2. react-ui transitively imports `.css` (via @uiw/react-md-editor), which Node can't load
 *      (ERR_UNKNOWN_FILE_EXTENSION).
 *
 * These hooks fix both at the Node layer, so they work whether or not Vite ends up inlining react-ui.
 * Registered from `tlsSetup.ts` via module.register before any test imports react-ui.
 */
import { stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  let resolved;
  try {
    resolved = await nextResolve(specifier, context);
  } catch (err) {
    // Some directory subpaths fail at resolve time; retry with an explicit /index.js.
    if ((err?.code === 'ERR_UNSUPPORTED_DIR_IMPORT' || err?.code === 'ERR_MODULE_NOT_FOUND') && !/\.[cm]?jsx?$/.test(specifier)) {
      return nextResolve(`${specifier}/index.js`, context);
    }
    throw err;
  }
  // If it resolved to a real directory, redirect to its index.js (the dir-import case).
  if (resolved.url.startsWith('file:') && !/\.[cm]?jsx?(\?|#|$)/.test(resolved.url)) {
    try {
      if ((await stat(fileURLToPath(resolved.url))).isDirectory()) {
        return { ...resolved, url: pathToFileURL(`${fileURLToPath(resolved.url)}/index.js`).href };
      }
    } catch {
      /* not a filesystem path or missing — leave as-is */
    }
  }
  return resolved;
}

export async function load(url, context, nextLoad) {
  if (/\.css(\?|#|$)/.test(url)) {
    return { format: 'module', source: 'export default {};', shortCircuit: true };
  }
  return nextLoad(url, context);
}
