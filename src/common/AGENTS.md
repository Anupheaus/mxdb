# Common layer (`src/common/`)

Shared code imported by both client and server. Defines the collection contract and owns all sync-critical logic.

## Overview

The common layer does three things: (1) defines collection types that clients and servers agree on via `defineCollection`, (2) owns the auditor — the library's conflict-resolution engine, and (3) contains the sync engine — the four-component protocol that moves data between clients and server.

Neither the client nor the server may import from each other; all cross-layer contracts live here.

## Contents

### Collection definition
- `defineCollection.ts` — factory; returns an `MXDBCollection` token used on both sides
- `registries.ts` — runtime `Map` from collection token to `MXDBCollectionConfig`; read by both client and server at mount

### Models (`models/`)
- `collectionsModels.ts` — `MXDBCollection`, `MXDBCollectionConfig`, `MXDBCollectionIndex`, `QueryProps`, `MongoDocOf`
- `authModels.ts` — `MXDBUserDetails`, `MXDBDeviceInfo`, auth shapes
- `hookModels.ts` — shared types for the factory-hook pattern: `RecordTypeOfCollection<C>`, `ExtensionsType`, `RemoveDasherized<Name>` (converts `'order-item'` → `'orderItem'` at the type level). Used by both client and server `createUseRecord` / `createUseRecords`.
- `internalModels.ts` — library-private types
- `internalSyncModels.ts` — sync-protocol types shared across layers

### Internal socket wiring
- `internalActions.ts` — C2S socket action descriptors
- `internalEvents.ts` — S2C socket event descriptors
- `internalSubscriptions.ts` — socket subscription descriptors

### Auditor (`auditor/`)
All audit trail logic: create, update, delete, merge, replay, diff. See [auditor/AGENTS.md](auditor/AGENTS.md).

### Sync engine (`sync-engine/`)
Four-component protocol (ClientDispatcher, ServerReceiver, ServerDispatcher, ClientReceiver). See [sync-engine/AGENTS.md](sync-engine/AGENTS.md).

## Architecture

`defineCollection` registers a config into a module-level `configRegistry`. Both the client `Db` and the server `ServerDb` look up configs from this registry at mount time — same registry instance because both import from `@anupheaus/mxdb/common`. Configs must be registered before either side mounts.

## Related

- [auditor/AGENTS.md](auditor/AGENTS.md) — conflict resolution and audit trail
- [sync-engine/AGENTS.md](sync-engine/AGENTS.md) — four-component sync protocol
- [../client/AGENTS.md](../client/AGENTS.md) — consumes common
- [../server/AGENTS.md](../server/AGENTS.md) — consumes common
