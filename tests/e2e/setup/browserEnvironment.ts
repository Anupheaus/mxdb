/**
 * Browser-like globals for Node e2e tests (fake IndexedDB + JSDOM + `self`).
 *
 * - **fake-indexeddb**: `global.indexedDB` for client Db/DbCollection.
 * - **JSDOM**: `window` / `document` so client and react-ui imports that touch the DOM succeed.
 * - **Node `ws` as `WebSocket`**: so code paths that still use the browser WebSocket API get TLS behaviour
 *   compatible with `preload-tls.cjs` (Vitest e2e uses `environment: 'node'` for engine.io itself).
 *
 * Loaded via {@link ./vitestGlobals.ts} from repo-root `vitest.e2e.config.ts` (`pnpm run test:e2e` / `test:stress`).
 * (after {@link ./e2eVitestSetup.ts}, which mocks `@anupheaus/common`). Do not import
 * `@anupheaus/common` from this module — it would load the real Logger before that mock applies.
 *
 * `setupE2E` may temporarily delete `window` while starting the server so Logger does not treat the
 * Node process as a browser.
 *
 * `SqliteWorkerClient` checks for `Worker` at construction; in Node there is no Worker, so it uses
 * its inline SQLite runner — no extra shim needed here.
 *
 * Safe to call multiple times (no-op after first install).
 */
import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import WS from 'ws';

declare global {
  // eslint-disable-next-line no-var -- test global gate
  var __mxdbE2eBrowserInstalled: boolean | undefined;
}

export function installBrowserEnvironment(): void {
  if (globalThis.__mxdbE2eBrowserInstalled) return;

  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://localhost',
  });

  (dom.window as unknown as { indexedDB: IDBFactory }).indexedDB = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;

  (globalThis as unknown as { window: unknown }).window = dom.window;
  (globalThis as unknown as { document: Document }).document = dom.window.document;

  // Patch only the missing static; keep URL as a constructor (same approach as legacy stress globals).
  const urlGlobal = (dom.window as unknown as { URL?: typeof URL }).URL ?? URL;
  if (typeof (urlGlobal as { createObjectURL?: unknown }).createObjectURL !== 'function') {
    (urlGlobal as unknown as { createObjectURL: (obj: Blob | MediaSource) => string }).createObjectURL = () =>
      'blob:mxdb-e2e';
  }
  (globalThis as unknown as { URL: unknown }).URL = urlGlobal;
  (globalThis as unknown as { self: unknown }).self = dom.window as unknown;

  // JSDOM's WebSocket cannot use our TLS preload (self-signed e2e HTTPS). Node `ws` uses
  // `tls.connect`, which preload-tls.cjs patches, so socket.io wss upgrades succeed in Vitest.
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WS as unknown as typeof WebSocket;
  (dom.window as unknown as { WebSocket: typeof WebSocket }).WebSocket = WS as unknown as typeof WebSocket;

  globalThis.__mxdbE2eBrowserInstalled = true;
}
