# Patterns

Recipes for building on mxdb: collections, client and server data hooks, write guards, records and edit reconciliation.

## Docs

- [Client data hooks](client-data-hooks.md): createUseRecord and createUseRecords: the factory client hooks, extensions, live-value comparison and read-only records.
- [Collections as the primary data layer](collections.md): define a collection as the primary data layer: seed data, versions, sync sets and server-only wiring.
- [Editing reconciliation against a live collection](editing-reconciliation.md): Keep unsaved local edits when a live collection update arrives, using useUpdatableState and an isDirtyRef.
- [Pure logic, colocated tests and barrels](pure-logic-and-tests.md): Keep testable logic pure and free of useCollection, with a colocated test file and barrel imports.
- [Records: interface plus namespace](records.md): The interface plus namespace record shape, how models are imported, and the mxdb folder grammar table.
- [Server data hooks](server-data-hooks.md): Server data hooks: createUseRecords with helpers and extensions, one file each, all server data access through them.
- [Write guards: before-write hooks and the read gate](write-guards.md): Before-write hooks, amend versus reject, write locks, and onQuery as both the read and the write gate.
