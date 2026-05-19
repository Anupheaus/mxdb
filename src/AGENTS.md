# Source (`src/`)

The entire library implementation — three cooperative layers that must all agree on collection definitions.

## Overview

| Layer | Directory | Role |
|-------|-----------|------|
| **Common** | `src/common/` | Shared types, `defineCollection`, auditor, sync engine, internal socket wiring |
| **Client** | `src/client/` | React provider, hooks, SQLite-backed local store, client-side sync |
| **Server** | `src/server/` | `startServer`, MongoDB persistence, server-side sync, auth |

Each layer has its own package export (`@anupheaus/mxdb/common`, `/client`, `/server`). Common is consumed by both client and server; neither imports from the other.

Collection definitions (`defineCollection`) must be registered before `startServer()` / `<MXDBSync>` mount — they live in common and are read by both sides at runtime via a module-level registry.

## Related

- [common/AGENTS.md](common/AGENTS.md) — shared types, auditor, sync engine
- [client/AGENTS.md](client/AGENTS.md) — React client, hooks, SQLite store
- [server/AGENTS.md](server/AGENTS.md) — server startup, MongoDB, auth
