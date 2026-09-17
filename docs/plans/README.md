# Plans & target specifications

Documents here describe **intended** architecture and sync contracts (C2S/S2C, local-first creates, master **design.md**). Treat them as the **spec**; cross-check **`src/`** when behaviour differs during migration.

| Document | Purpose |
|----------|---------|
| [design.md](design.md) | Master design specification (auditor semantics, storage, WebAuthn, change plan) |
| [client-to-server-synchronisation.md](client-to-server-synchronisation.md) | C2S batched audit sync spec |
| [server-to-client-synchronisation.md](server-to-client-synchronisation.md) | S2C push / mirror / ack spec |
| [client-record-creation-sync.md](client-record-creation-sync.md) | Local-first record creation and upsert flow |
| [virtual-collections.md](virtual-collections.md) | Server-only projected collections & public (JWT-scoped) read access |
| [../../src/common/sync-engine/readme.md](../../src/common/sync-engine/readme.md) | **Living reference** — `src/common/sync-engine/` module (moved from `plans/`) |

**Using the library:** start at [docs/README.md](../README.md) (guides + features).
