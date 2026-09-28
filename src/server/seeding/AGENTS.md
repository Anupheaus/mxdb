# Server seeding (`src/server/seeding/`)

Runs each collection's `onSeed` hook at startup (`shouldSeedCollections: true`) against the ambient database.

## Contents

- `seedCollections.ts` — `seedCollections(collections)`: reads the database's seed state once, then runs every `onSeed`
  with a `seedWith` bound to that collection. One collection's failure is logged and never stops the others. If the seed
  state cannot be read (database unreachable), nothing is seeded and the reason is logged.
- `seedState.ts` — `loadSeedState(db)` / `useSeedState()`: which fixed records each collection last applied, held in the
  **seeded database** in the raw collection `mxdb_seeds` (`{ _id: collectionName, hash, appliedAt }`). Like
  `mxdb_authentication`, it is mxdb's own: never synced, and the change stream ignores it.

## How `seedWith` decides

`seedWith({ fixedRecords, count, create, validate })` hashes `fixedRecords` (`Object.hash`) and compares it with the hash
stored for the collection:

| Stored hash | Collection | What happens |
|---|---|---|
| equal | any | skipped: nothing read or written |
| different | any | fixed records are repserted where they differ, `count` is topped up with `create`, `validate` runs, then the hash is saved |
| none | empty | seeded in full, as above (a fresh database) |
| none | has records | **adopted**: only the fixed records it lacks are inserted, no stored record is overwritten, `count`/`validate` are not run, and the hash is saved |

- The hash is saved only **after** the records are written, so a failed seed is retried on the next start.
- A seed with no `fixedRecords` (count and create only) has no hash: its top-up and `validate` run on every start.

## Decisions

- **The seed state lives in the database, not the working directory** (Vision sc-470, 28 Sep 2026). It used to be
  `seededData.json` in `process.cwd()`. That broke twice: a container's filesystem is replaced on every deploy, so every
  fixed-record seed re-applied on every deploy and overwrote records edited in the app; and the file had no database
  dimension, so seeding a second database (another tenant) was silently skipped. The file is no longer read or written.
- **Upgrading adopts rather than re-applies.** A database seeded under the old file has no `mxdb_seeds` entry. Treating
  that as "never seeded" would overwrite every edited fixed record once, on the upgrade. So a collection that already
  holds records is adopted: the current hash is recorded, and only fixed records missing from it are added. The cost:
  a changed fixed record shipped in the same release as the upgrade is not applied to an existing database; change it
  again, or write a migration, if it matters.
