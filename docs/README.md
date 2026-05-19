# MXDB documentation

## Start here

| Document | Audience | Purpose |
|----------|----------|---------|
| [guides/client-guide.md](./guides/client-guide.md) | App developers (React) | Mount **`MXDBSync`**, hooks, local DB, auth, sync behaviour |
| [guides/server-guide.md](./guides/server-guide.md) | Backend developers | **`startServer`**, MongoDB, collections, auth hooks, extensions |
| [reference/tech-overview.md](./reference/tech-overview.md) | Both | High-level architecture and sync flows (Mermaid) |
| [reference/features.md](./reference/features.md) | Both | What the package exports, socket **actions** / **events** / **subscriptions** |

## Plans & target specifications (`plans/`)

Normative **target behaviour** and **long-form design** (implementation may lag in places):

| Document | Purpose |
|----------|---------|
| [plans/client-to-server-synchronisation.md](./plans/client-to-server-synchronisation.md) | **`ClientToServerSynchronisation`**, **`mxdbClientToServerSyncAction`**, debounce, queue, phase B gate |
| [plans/server-to-client-synchronisation.md](./plans/server-to-client-synchronisation.md) | **`ServerToClientSynchronisation`**, mirror, **`mxdbServerToClientSyncAction`**, ack |
| [plans/client-record-creation-sync.md](./plans/client-record-creation-sync.md) | Local-first creates vs server reconciliation |
| [plans/design.md](./plans/design.md) | Master design spec, auditor semantics, platform notes (WebAuthn, OPFS, Cordova), change plan |

## History (`archive/`)

| Document | Purpose |
|----------|---------|
| [archive/](./archive/) | Older trackers / draft models — see [archive/README.md](./archive/README.md) |

## Package entry points

From **`package.json`** exports:

- **`@anupheaus/mxdb`** — resolves to **server** on Node, **client** in bundlers (check **`exports`** for your environment).
- **`@anupheaus/mxdb/server`** — `startServer`, server utilities.
- **`@anupheaus/mxdb/client`** — React client (`MXDBSync`, hooks).
- **`@anupheaus/mxdb/common`** — `defineCollection`, models, auditor, internal action/event **symbols** (for advanced wiring).
