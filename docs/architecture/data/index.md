# Data model

How mxdb decides conflicting writes: the audit entry's ULID, deletion and restoration.

## Docs

- [Conflict resolution: ULID last-write-wins](conflict-resolution.md): The audit entry's ULID is the only tie-breaker, plus how deletion and restoration behave across clients.
