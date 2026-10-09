# Conflict resolution: ULID last-write-wins

> The audit entry's ULID is the only tie-breaker, plus how deletion and restoration behave across clients.
>
> Status: accepted · Version 1

MXDB resolves conflicts by the **ULID of the audit entry**, and by nothing else. `replayHistoryEndState` sorts a record's audit entries by ULID and applies them in order; the last state applied is the record's value. `audit.merge` deduplicates server and client entries and sorts them the same way.

Record fields have no effect on ordering. A field such as `testDate` is arbitrary data on the record, never a tie-breaker.

## Deletion and restoration

A later update does not restore a deleted record. An `Updated` entry with a higher ULID than a `Deleted` one is still applied to the shadow state, but `live` stays empty until an explicit `Restored` entry exists. Restoration is manual: there is no automatic pathway from a concurrent update or from conflict resolution.

## Pending changes survive a deletion

A client may still send changes for a record the server has told it was removed. While the local audit has pending entries after its last branch anchor, the server-to-client deletion is skipped and the record stays local; a follow-up deletion arrives once the client's changes are acknowledged and its audit has collapsed to a new anchor.

Never truncate or rewrite audit entries: audit preservation is this library's core guarantee.
