# E2E setup — generic infrastructure

This folder holds **shared end-to-end test infrastructure** only: browser fakes, Mongo + HTTPS server lifecycle, the React/SQLite sync client harness, run logging, and **generic** waits/helpers that any e2e spec can import.

**What does *not* belong here:** anything tied to a particular suite, feature area, or scenario. Helpers, fixtures, extra config, harness state, or assertions that exist to serve **one** test file or **one** subfolder under `tests/e2e/` should live **next to those tests** (same folder or a sibling `utils.ts` / `fixtures/` under that area). Examples today: stress workload harnesses under `tests/e2e/stress/`; top-level specs like `deletions.e2e.test.ts` stay thin and import from `./setup` for shared plumbing only.

**Rule of thumb:** if removing a test folder would make a setup file unused or meaningless, that code probably belongs **inside** that folder, not in `setup/`. New `tests/e2e/<area>/` trees should follow the same pattern.

See also **`tests/e2e/README.md`** for how the e2e tree is organized.

---

## Public API (barrel)

Import from `tests/e2e/setup` (or a relative `./setup` from other files under `tests/e2e/`):

```ts
import {
  installBrowserEnvironment,
  e2eTestCollection,
  type E2eTestRecord,
  type E2eTestMetadata,
  type RunLogEvent,
  type RunLogDetail,
  type RunLogger,
  E2E_MONGO_DB_NAME,
  clearLiveAndAuditCollections,
  clearE2eTestCollections,
  type ClearLiveAndAuditOptions,
  e2eNoopRunLogger,
  e2eForwardingRunLogger,
  createRunLogger,
  type CreateRunLoggerOptions,
  getE2eRunLogger,
  setE2eRunLogger,
  setupE2E,
  resetE2E,
  teardownE2E,
  useClient,
  useServer,
  useRunLogger,
  waitUntilAsync,
  waitForLiveRecordAbsent,
  waitForAllClientsIdle,
  auditEntryTypesChronological,
  type E2EClientHandle,
  type E2EServerAccess,
  type SetupE2EOptions,
  type WaitForAllClientsIdleOptions,
  createSyncClient,
  type SyncClient,
  readServerRecords,
  type ReadServerRecordsOptions,
  readServerAuditDocuments,
  type ReadServerAuditDocumentsOptions,
  formatServerLogDetail,
  condenseServerLogDetail,
  startLifecycle,
  startMongo,
  startServerInstance,
  setServerLogCallback,
  stopLifecycle,
  type LifecycleState,
  type ServerInstance,
  vitestE2eTlsEnv,
  condenseAppLoggerDetail,
  type AppLoggerRunLogDetail,
} from './setup';
```

Most tests only need a subset: `setupE2E`, `resetE2E`, `teardownE2E`, `useClient`, `useServer`, and the wait helpers.

**Vitest:** `vitest.e2e.config.ts` uses `environment: 'node'` (not Vitest’s built-in `jsdom`) so `engine.io-client` uses the Node `ws` stack, which honors `preload-tls.cjs` for `wss://` to the self-signed e2e HTTPS server. Browser globals come from `installBrowserEnvironment()` in `vitestGlobals.ts` (JSDOM + `fake-indexeddb` + Node `ws` as `WebSocket`). `test.env` is set from `vitestE2eTlsEnv(__dirname)` (`preload-tls.cjs` + `certs/ca.crt`). `setupFiles`: `e2eVitestSetup.ts` then `vitestGlobals.ts`. Run CRUD with `pnpm test:crud`. Logs default to `tests/e2e/logs/{prefix}-{timestamp}.log` (nanosecond-prefixed lines; `server_log` / `app_logger` entries condensed).

---

## Lifecycle

### `installBrowserEnvironment(): void`

Installs browser-like globals in Node: `fake-indexeddb`, JSDOM (`window` / `document`), `self`, and a stub `URL.createObjectURL` if missing. **Idempotent** (guarded by `globalThis.__mxdbE2eBrowserInstalled`).

`setupE2E()` calls this internally. Vitest loads it again via `vitestGlobals.ts` so globals exist before test modules import client code.

---

### `setupE2E(options?: SetupE2EOptions): Promise<void>`

**Call in `beforeAll`.** Ensures browser environment, temporarily removes `global.window` / `document` while starting infrastructure (avoids the server process treating the worker as a browser), then:

1. Creates a run log via `createRunLogger` (defaults under `tests/e2e/logs/`, prefix `e2e`; override with `options.runLoggerOptions`).
2. Registers `setE2eRunLogger` and `setServerLogCallback` so the forked server’s stdout/stderr become `server_log` lines in that file.
3. Starts MongoDB Memory **ReplSet** and forks the HTTPS sync server (`serverProcess.cjs` in this folder), registering the default `e2eTest` collection (`e2eTestFixture.ts`, re-exported from `types.ts`).
4. Unless `skipInitialMongoClear` is set, clears `e2eTest` and `e2eTest_sync` in database `E2E_MONGO_DB_NAME` (`mongoConstants.ts`, default `mxdb-e2e`). Client and server use socket name `E2E_SOCKET_API_NAME` (`mxdb-e2e`); the forked child reads `MXDB_E2E_*` env vars (`E2E_SERVER_PROCESS_ENV`).

`useClient` wires `createSyncClient` to `e2eForwardingRunLogger` so client/socket events go to the same log.

Throws if `setupE2E` was already called in this worker without `teardownE2E()`.

---

### `resetE2E(): Promise<void>`

**Call in `beforeEach` for isolated tests.** Unmounts every `useClient` client, closes each client DB (`dbs.close`), clears the client map, and runs `clearE2eTestCollections` on the current Mongo URI.

After reset, the next `useClient('sameLabel')` is a **new** React tree and DB (`e2e-client-{label}`).

---

### `teardownE2E(): Promise<void>`

**Call in `afterAll`.** Unmounts/closes all clients, `stopLifecycle(true)` (server child + Mongo), clears server log callback and `setE2eRunLogger(undefined)`, closes the log stream. No-op if setup never ran.

---

### `useClient(label: string): E2EClientHandle`

**Requires active context after `setupE2E()`.** Named client; created on first use per `label`. Empty `label` throws. Logging id `e2e-{label}`, IndexedDB/SQLite DB name `e2e-client-{label}`.

`connect(host?: string)` — if `host` is omitted, uses `useServer().socketHost` (`localhost:${port}`).

---

### `useServer(): E2EServerAccess`

Fresh object each call; same underlying lifecycle (Mongo URI, port, child process).

| Member | Description |
|--------|-------------|
| `mongoUri` | Memory ReplSet connection string. |
| `port` | HTTPS listen port. |
| `socketHost` | Host **without** protocol, e.g. `localhost:12345` (client builds `wss://`). |
| `stopServer()` | Stops only the server child. |
| `restartServer()` | Stop, brief wait (`SERVER_RESTART_WAIT_MS`), respawn on same port. |
| `readLiveRecords()` | All `e2eTest` documents as `E2eTestRecord[]`. |
| `readAudits(liveCollectionName?)` | Map id → `ServerAuditOf<E2eTestRecord>` from `{name}_sync` (default `e2eTest`). |
| `clearStoredCollectionData()` | Truncate live + `_sync` for this URI (same as `clearE2eTestCollections`). |
| `waitForLiveRecord(recordId, options?)` | Poll until row exists or timeout (default 30s, 50ms interval). |

---

### `useRunLogger(): RunLogger`

Returns the `RunLogger` instance created by `setupE2E` for custom `log(event, detail?)` lines in tests (events defined in `types.ts`).

---

### `clearE2eTestCollections(mongoUri: string): Promise<void>`

Deletes all documents in the default live + `_sync` pair (`e2eTest` / `e2eTest_sync` in `E2E_MONGO_DB_NAME`). Used by `setupE2E` / `resetE2E`.

### `clearLiveAndAuditCollections(mongoUri, options?): Promise<void>`

General form: truncate `{liveCollectionName}` and `{liveCollectionName}_sync` (defaults match `clearE2eTestCollections`). Use when a future suite registers a different live collection name on the same Memory Server.

---

## Generic wait helpers (`utils.ts`)

### `waitUntilAsync(predicate, label, timeoutMs?, intervalMs?): Promise<void>`

Polls until `predicate()` resolves **true** (default timeout 60s, interval 50ms).

### `waitForLiveRecordAbsent(recordId, timeoutMs?): Promise<void>`

Polls `useServer().readLiveRecords()` until no row matches `recordId` (default 30s).

### `waitForAllClientsIdle(clients, options?): Promise<void>`

Every client: `!getIsSynchronising()` and `getPendingC2SSyncQueueSize() === 0` for `stableTicksRequired` consecutive polls (default 8 × `pollMs` default 100ms). Default timeout 90s. Empty `clients` is a no-op.

| Option | Description |
|--------|-------------|
| `requireConnected` | If `true`, also require `getIsConnected()` on each client (default `false`). |

### `auditEntryTypesChronological<R>(audit): AuditEntryType[]`

Entry types in a `ServerAuditOf<R>`, ordered by ULID time (`decodeTime(entry.id)`).

---

## Run logging

- **`e2eNoopRunLogger`** — no-op `log` for custom `createSyncClient` callers that do not want a file.
- **`e2eForwardingRunLogger`** — forwards to `getE2eRunLogger()` (used by `useClient` after setup).
- **`createRunLogger(options?)`** — opens `{logsDir}/{prefix}-{iso}.log`, prunes older matching files (`keep`, default 10). Normally called only from `setupE2E`; use `SetupE2EOptions.runLoggerOptions` to change directory/prefix/keep (e.g. stress tests use prefix `stress`).
- **`getE2eRunLogger` / `setE2eRunLogger`** — active logger for Vitest `Logger` mock and forwarding.

---

## Types

- **`types.ts`** — re-exports **`e2eTestFixture.ts`** (`e2eTestCollection`, `E2eTestRecord`, `E2eTestMetadata`) and **`runLogTypes.ts`** (`RunLogger`, `RunLogEvent`, `RunLogDetail`).
- **`RunLogEvent`** includes shared harness events (`client_*`, `sync_*`, `server_log`, `app_logger`, `error`) and **suite-agnostic** validation hooks: `validation_summary`, `sync_idle_snapshot`, `validation_record_detail` (suites attach their own detail payloads).

---

## Advanced exports (optional)

Useful for custom harnesses or tooling; most e2e specs do not import these.

| Export | Role |
|--------|------|
| `createSyncClient`, `SyncClient` | Build a client without `useClient` (see `syncClient.tsx`). |
| `readServerRecords(mongoUri, options?)` | Read a live collection as `E2eTestRecord[]` (default collection/db from the default fixture). |
| `readServerAuditDocuments(mongoUri, liveCollectionName, options?)` | Read `_sync` audits as a `Map`. |
| `formatServerLogDetail`, `condenseServerLogDetail` | Parse/condense server stdout lines for logs. |
| `condenseAppLoggerDetail`, `AppLoggerRunLogDetail` | Condense mocked app logger payloads. |
| `startLifecycle`, `startMongo`, `startServerInstance`, `stopLifecycle`, `setServerLogCallback` | Lower-level lifecycle control (`serverLifecycle.ts`). |
| `vitestE2eTlsEnv` | Build `test.env` for Vitest forks (TLS trust). `vitestSyncTestTlsEnv` is a deprecated alias. |
| `E2E_MONGO_DB_NAME` | Default DB name for Memory Server + server child. |

---

## Files in this folder

| File / dir | Purpose |
|------------|---------|
| `index.ts` | Barrel exports. |
| `context.ts` | E2E context: `setupE2E`, `resetE2E`, `teardownE2E`, `useClient`, `useServer`, `useRunLogger`. |
| `types.ts` | Re-exports `e2eTestFixture` + `runLogTypes` (stable import path). |
| `e2eTestFixture.ts` | Default `e2eTest` collection + `E2eTestRecord` shape. |
| `runLogTypes.ts` | `RunLogger`, `RunLogEvent`, `RunLogDetail`. |
| `mongoConstants.ts` | `E2E_MONGO_DB_NAME`, `E2E_SOCKET_API_NAME`, `E2E_SERVER_PROCESS_ENV`, `E2E_DEFAULT_CLIENT_DB_PREFIX`. |
| `browserEnvironment.ts` | `installBrowserEnvironment`. |
| `utils.ts` | `waitUntilAsync`, `waitForLiveRecordAbsent`, `waitForAllClientsIdle`, `auditEntryTypesChronological`. |
| `syncClient.tsx` | React harness + `createSyncClient`. |
| `mongoData.ts` | `clearLiveAndAuditCollections`, `clearE2eTestCollections`. |
| `readServerRecords.ts` / `readServerAudits.ts` | Direct Mongo reads for live rows / audits. |
| `serverLifecycle.ts` | Mongo ReplSet, fork `serverProcess.cjs`, restart/stop. |
| `serverProcess.cjs` | Child entry: starts authenticated MXDB server for e2e. |
| `runLogger.ts` | File `createRunLogger`, active logger get/set, `e2eNoopRunLogger`, `e2eForwardingRunLogger`. |
| `formatServerLogDetail.ts` | Server line → structured detail. |
| `appLoggerRunLogBridge.ts` | App logger → condensed log lines. |
| `vitestTlsEnv.ts` | `vitestE2eTlsEnv`. |
| `preload-tls.cjs` | Node preload: trust local CA for `wss://localhost`. |
| `certs/` | Local CA + localhost TLS material for the e2e server. |
| `e2eVitestSetup.ts` | Vitest `setupFiles`: mocks / timeouts. |
| `vitestGlobals.ts` | Vitest `setupFiles`: `installBrowserEnvironment`. |

---

## Typical test shape

```ts
beforeAll(async () => { await setupE2E(); }, 90_000);
beforeEach(async () => { await resetE2E(); });
afterAll(async () => { await teardownE2E(); }, 30_000);
```

Examples:

- **`tests/e2e/harness.smoke.test.ts`** — minimal upsert + `waitForLiveRecord`.
- **`tests/e2e/deletions.e2e.test.ts`** — disconnect/reconnect, `waitForAllClientsIdle`, `auditEntryTypesChronological`.
- **`tests/e2e/stress/clientSync.integration.test.ts`** — long run; uses `setupE2E({ runLoggerOptions: { logsDir: …, prefix: 'stress' } })` and keeps stress-specific harness code under `tests/e2e/stress/` (same idea for any future `tests/e2e/<suite>/` folder).
