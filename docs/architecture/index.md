# Architecture

How the system is built: decisions, services, APIs and data.

## Folders

- [Services](services/index.md): The synchronisation service: client-to-server batches, server-to-client pushes and acks.
- [Data model](data/index.md): How mxdb decides conflicting writes: the audit entry's ULID, deletion and restoration.
