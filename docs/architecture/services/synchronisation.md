# Synchronisation: client to server and back

> How mxdb syncs: the batched audit push, the per-socket mirror push with ack, and the read paths.
>
> Status: accepted · Version 1

MXDB keeps a local replica per client and synchronises it with MongoDB over Socket.IO through nexus actions.

## Client to server

A local upsert or remove appends to the audit and enqueues work for `ClientToServerSynchronisation`. A debounced batch is sent as `mxdbClientToServerSyncAction`. The server merges and replays the audits into MongoDB, updates the per-socket mirror, and returns an ack with a result per record id; the client collapses its queue from that response.

## Server to client

The server decides when to push — informed by change streams and the per-connection mirror — and calls `mxdbServerToClientSyncAction` on the client. The client waits for the sync gate where required, applies payloads and removals to its local database, then acks (`successfulRecordIds`, `deletedRecordIds`, …) so the mirror can advance.

## Reads

Besides sync, clients fetch with the `get`, `getAll`, `query` and `distinct` actions, and may hold subscriptions for long-lived query, distinct and get-all streams. The hooks (`useQuery`, `useGetAll`, `useDistinct`) mirror the same pattern.

## Packages

`@anupheaus/mxdb/client` (React app), `@anupheaus/mxdb/server` (Node) and `@anupheaus/mxdb/common` (collection definitions, auditor and the internal action, event and subscription names). `react` and `react-dom` are peer dependencies and must stay there: a private React copy makes consumers load a second react-ui or nexus and their providers stop matching.
