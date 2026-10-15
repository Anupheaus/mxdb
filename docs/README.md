# Vision docs

Architecture decisions, patterns and coding standards. Each doc is short and covers one topic: scan this index, then open only the docs your task touches. Every folder also has an `index.md` describing what's in it.

These files are maintained by the Architect agent in Forge and synced from there, so edits made here by hand will be overwritten. To change or record a decision, tell any Forge agent; it goes to the Architect.

## [Patterns](patterns/index.md)

Recipes for building on mxdb: collections, client and server data hooks, write guards, records and edit reconciliation.

- [Client data hooks](patterns/client-data-hooks.md): createUseRecord and createUseRecords: the factory client hooks, extensions, live-value comparison and read-only records.
- [Collections as the primary data layer](patterns/collections.md): define a collection as the primary data layer: seed data, versions, sync sets and server-only wiring.
- [Editing reconciliation against a live collection](patterns/editing-reconciliation.md): Keep unsaved local edits when a live collection update arrives, using useUpdatableState and an isDirtyRef.
- [Pure logic, colocated tests and barrels](patterns/pure-logic-and-tests.md): Keep testable logic pure and free of useCollection, with a colocated test file and barrel imports.
- [Records: interface plus namespace](patterns/records.md): The interface plus namespace record shape, how models are imported, and the mxdb folder grammar table.
- [Server data hooks](patterns/server-data-hooks.md): Server data hooks: createUseRecords with helpers and extensions, one file each, all server data access through them.
- [Write guards: before-write hooks and the read gate](patterns/write-guards.md): Before-write hooks, amend versus reject, write locks, and onQuery as both the read and the write gate.

## [Services](architecture/services/index.md)

The synchronisation service: client-to-server batches, server-to-client pushes and acks.

- [Synchronisation: client to server and back](architecture/services/synchronisation.md): How mxdb syncs: the batched audit push, the per-socket mirror push with ack, and the read paths.

## [Data model](architecture/data/index.md)

How mxdb decides conflicting writes: the audit entry's ULID, deletion and restoration.

- [Conflict resolution: ULID last-write-wins](architecture/data/conflict-resolution.md): The audit entry's ULID is the only tie-breaker, plus how deletion and restoration behave across clients.

## [Guides](guides/index.md)

What this repo is, what it depends on and who depends on it.

- [mxdb — repo overview](guides/repo-overview.md): What @anupheaus/mxdb is, what it depends on, and who reads its docs.
