# End-to-end tests (`tests/`)

Vitest e2e test suites: CRUD, performance, and stress tests running in Node with JSDOM, fake IndexedDB, a real MongoDB in-process, and a forked HTTPS MXDB sync server.

## Overview

All e2e tests live under `tests/e2e/`. They are distinct from the unit tests in `test/` (which is a manually-run browser/server app, not automated specs).

## Contents

- **`tests/manifest/`**: `package-manifest.unit.tests.ts` checks `package.json` itself. `react` / `react-dom` must be peer dependencies (`^18.2.0 || ^19.0.0`), absent from `dependencies`, and present in `devDependencies`. It runs with the unit suite (`pnpm test:ci`) because it matches `**/*.unit.tests.ts`.
- **`tests/e2e/`** — all e2e specs and infrastructure. See [e2e/README.md](e2e/README.md) for the full layout.
  - **`tests/e2e/setup/`** — shared infrastructure: `setupE2E`, `useClient`, `useServer`, `SyncClient`, TLS certs, logging. See [e2e/setup/README.md](e2e/setup/README.md).
  - **`tests/e2e/crud-operations/`** — CRUD and data integrity specs
  - **`tests/e2e/stress/`** — multi-client convergence and network-failure stress tests. See [e2e/stress/README.md](e2e/stress/README.md).

## Running tests

```sh
pnpm test:crud         # CRUD e2e tests
pnpm test:performance  # performance e2e tests
pnpm test:stress       # stress / convergence tests
pnpm test:all          # all suites via the orchestrator script (preferred)
```

See root `AGENTS.md` for the `pnpm test:all` output format and how to report results.

## Related

- [../test/AGENTS.md](../test/AGENTS.md) — manual test app (not automated)
- [../AGENTS.md](../AGENTS.md) — root AGENTS.md with test-all instructions
- [../src/common/sync-engine/AGENTS.md](../src/common/sync-engine/AGENTS.md) — sync engine stress test lives in src/
