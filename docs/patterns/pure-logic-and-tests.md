# Pure logic, colocated tests and barrels

> Keep testable logic pure and free of useCollection, with a colocated test file and barrel imports.
>
> Status: accepted · Version 1

Business logic that can be pure is pulled into its own file with a colocated `*.tests.ts`.

- Pure functions import only `@anupheaus/common` (plus small utilities such as luxon), so their tests avoid the ESM-only `@anupheaus/mxdb/server` chain: importing the server data layer into a test forces the whole ESM toolchain and slows or breaks the unit test.
- Shape: an orchestrator that touches collections and I/O, plus pure helpers that are tested. Never mix data access into the testable core.
- Every folder — collections, hooks, models — has an `index.ts` doing `export * from './file-name'`, and cross-module imports target the barrel (`…/models`, `…/hooks`) rather than a deep file. That keeps the mxdb-facing surface stable as internal files move.
