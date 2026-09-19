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
  // @mui's dist is CJS-style code (extensionless relative imports, directory subpaths) loaded here as
  // ESM, where Node does neither extension nor directory resolution. Emulate both.
  const hasExt = /\.[cm]?jsx?(\?|#|$)/.test(specifier);
  let resolved;
  try {
    resolved = await nextResolve(specifier, context);
  } catch (err) {
    if ((err?.code === 'ERR_UNSUPPORTED_DIR_IMPORT' || err?.code === 'ERR_MODULE_NOT_FOUND') && !hasExt) {
      // Try `<specifier>.js` (a file), then `<specifier>/index.js` (a directory).
      for (const suffix of ['.js', '/index.js']) {
        try {
          return await nextResolve(`${specifier}${suffix}`, context);
        } catch { /* try the next suffix */ }
      }
    }
    throw err;
  }
  // Resolved, but to a real directory: redirect to its index.js (the directory-import case).
  if (!hasExt && resolved.url.startsWith('file:') && !/\.[cm]?jsx?(\?|#|$)/.test(resolved.url)) {
    try {
      const filePath = fileURLToPath(resolved.url);
      if ((await stat(filePath)).isDirectory()) {
        return { ...resolved, url: pathToFileURL(`${filePath}/index.js`).href };
      }
    } catch {
      /* not a filesystem path, or missing — leave as-is */
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
