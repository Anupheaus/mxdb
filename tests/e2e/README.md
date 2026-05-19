# End-to-end tests (`tests/e2e`)

Vitest e2e specs run in Node with JSDOM + fake IndexedDB, a MongoDB Memory ReplSet, and a forked HTTPS MXDB sync server. Configuration: root **`vitest.e2e.config.ts`** (`pnpm test:e2e`).

## Layout

| Location | Purpose |
|----------|---------|
| **`setup/`** | **Generic** infrastructure only: lifecycle (`setupE2E`, `useClient`, `useServer`, …), shared types (`E2eTestRecord`), generic waits, logging, TLS, server child. Documented in [setup/README.md](setup/README.md). |
| **`crud-operations/`** | CRUD and performance suite: `updates`, `deletions`, `subscriptions`, and `performance` specs plus `utils.ts` for shared test helpers. All use `setupE2E` / `resetE2E` / `teardownE2E` from `./setup`. |
| **`<suite>/`** (e.g. `stress/`) | **Suite-specific** code co-located with that area: config, fixtures, harness state, custom assertions, helpers used only by tests in that tree. |
| **Repo root of `e2e/`** (e.g. `deletions.e2e.test.ts`, `harness.smoke.test.ts`) | Specs that do not need their own folder; keep them small and depend on `./setup` for shared plumbing. |

**Convention:** When you add new folders under `tests/e2e/`, put code that exists **only** to support those tests **in or under that folder**. Do not grow `setup/` with scenario-specific logic—only promote helpers to `setup/` when they are clearly reusable across unrelated e2e areas.

## Logs

Default run logs: `tests/e2e/logs/` (prefix configurable via `setupE2E({ runLoggerOptions: … })`).
