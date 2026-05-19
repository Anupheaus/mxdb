# Technical overview

High-level picture of **MXDB**: how the **common**, **client**, and **server** pieces fit together, how data moves, and where to read more. For integration steps see [client-guide.md](../guides/client-guide.md) and [server-guide.md](../guides/server-guide.md). For symbol-level detail see [features.md](./features.md). Normative sync behaviour is in [plans/client-to-server-synchronisation.md](../plans/client-to-server-synchronisation.md) and [plans/server-to-client-synchronisation.md](../plans/server-to-client-synchronisation.md).

---

## 1. System context

The library connects **React clients** (local SQLite per user, encrypted at rest when a key is available) to a **Node server** backed by **MongoDB**. The real-time link is **Socket.IO** via **nexus** (`defineAction` / `defineEvent`).

```mermaid
flowchart LR
  subgraph client["Browser / React app"]
    UI["App + hooks"]
    LOC["Local DB (SQLite / OPFS)"]
    UI <--> LOC
  end

  subgraph mxdb["MXDB"]
    CL["Client package"]
    SV["Server package"]
    CM["Common · defineCollection, auditor, actions"]
    CL --- CM
    SV --- CM
  end

  subgraph backend["Your backend"]
    NODE["Node + startServer"]
    MDB[(MongoDB)]
    NODE <--> MDB
  end

  UI --> CL
  CL <-->|"WSS + actions / events"| NODE
  SV --> NODE
```

---

## 2. Logical layers

Shared **collection definitions** and **auditor** logic live in `common`. The server materialises the same conceptual model in MongoDB (live + audit where enabled). The client keeps a **local replica** and an **audit trail** used for merge, replay, and sync payloads.

```mermaid
flowchart TB
  subgraph common["src/common"]
    DC["defineCollection + registries"]
    AUD["auditor · merge / replay / hashes"]
    ACT["internalActions / events / subscriptions"]
    DC --> AUD
  end

  subgraph server["src/server"]
    SS["startServer / startAuthenticatedServer"]
    SDB["ServerDb + change streams"]
    ACTS["handlers: C2S sync, get, query, distinct"]
    S2C["ServerToClientSynchronisation (per socket)"]
    SS --> SDB
    SS --> ACTS
    SS --> S2C
  end

  subgraph client["src/client"]
    MX["MXDBSync"]
    BR["IndexedDbBridge · auth IDB + PRF key"]
    DBP["DbsProvider + SQLite worker"]
    C2S["ClientToServerSynchronisation + enqueue"]
    S2CP["ServerToClientProvider (S2C handler + ack)"]
    MX --> BR
    BR --> DBP
    BR --> C2S
    BR --> S2CP
  end

  common <--> server
  common <--> client
```

---

## 3. Client provider stack (authenticated session)

When the user has a stored auth entry, **IndexedDbBridge** derives the encryption key, opens **SocketAPI**, **DbsProvider**, and nests **C2S** / **S2C** providers. **TokenRotationProvider** sits under **MXDBSync** (outside this subgraph) to react to rotated tokens.

```mermaid
flowchart TB
  MX["MXDBSync"]
  IDX["IndexedDbBridge · AuthTokenContext"]
  SKT["SocketAPI · wss"]
  DBS["DbsProvider → SqliteWorkerClient"]
  C2SS["ClientToServerSyncProvider"]
  C2SP["ClientToServerProvider (enqueue on write)"]
  S2C["ServerToClientProvider"]

  MX --> IDX
  IDX --> SKT
  SKT --> DBS
  DBS --> C2SS
  C2SS --> C2SP
  C2SS --> S2C
```

Unauthenticated users still get **AuthTokenContext** (e.g. registration / invite) without the inner socket + DB tree.

---

## 4. Client → server: batched audit push

Local **upsert/remove** append to the audit and **enqueue** work for **ClientToServerSynchronisation**. A debounced batch is sent as **`mxdbClientToServerSyncAction`**. The server replays audits into MongoDB and updates its **S2C mirror** for that socket. The client collapses queue state from the response (see the C2S plan for phases and idempotency).

```mermaid
sequenceDiagram
  participant Hook as useCollection / useRecord
  participant DBC as DbCollection
  participant C2S as ClientToServerSynchronisation
  participant Sock as SocketAPI
  participant Srv as Server handler
  participant DB as MongoDB

  Hook->>DBC: upsert / remove
  DBC->>DBC: audit + local SQLite
  DBC->>C2S: enqueue
  C2S->>C2S: debounce + build batch
  C2S->>Sock: mxdbClientToServerSyncAction
  Sock->>Srv: request
  Srv->>DB: merge / replay / persist
  Srv->>Srv: update mirror row
  Srv-->>Sock: response
  Sock-->>C2S: ack + per-id result
  C2S->>DBC: collapse queue / anchors
```

---

## 5. Server → client: action + ack

The server decides when to push updates (e.g. after other clients’ writes, informed by **change streams** and the per-connection **mirror**). It invokes **`mxdbServerToClientSyncAction`** on the client; the client applies payloads **after** the C2S “phase B” gate when required, then returns an **ack** (`successfulRecordIds`, `deletedRecordIds`, …) so the server can advance its mirror.

```mermaid
sequenceDiagram
  participant Watch as clientDbWatches / change streams
  participant S2C as ServerToClientSynchronisation
  participant Sock as SocketAPI
  participant Cli as ServerToClientProvider
  participant LOC as Local DB

  Watch->>S2C: relevant change
  S2C->>S2C: diff vs mirror, build payload
  S2C->>Sock: call client action
  Sock->>Cli: mxdbServerToClientSyncAction
  Cli->>Cli: waitForS2CGate (C2S phase B)
  Cli->>LOC: apply records / removals
  Cli-->>Sock: ack
  Sock-->>S2C: ack
  S2C->>S2C: update mirror from ack
```

---

## 6. Reads and subscriptions

Besides sync, clients fetch data with **actions** (**get**, **getAll**, **query**, **distinct**) and can hold **subscriptions** for long-lived **query**, **distinct**, and **get-all** streams. Those paths talk to the server over the same socket abstraction; results hydrate or refresh local state according to the hook implementation (**`useQuery`**, **`useDistinct`**, **`useGetAll`** mirror the same pattern).

```mermaid
flowchart LR
  subgraph hooks["Client hooks"]
    UQ["useQuery / useGetAll / useGet / …"]
  end

  subgraph wire["Socket actions"]
    GA["mxdbGetAction"]
    GAA["mxdbGetAllAction"]
    QA["mxdbQueryAction"]
    DA["mxdbDistinctAction"]
  end

  subgraph sub["Subscriptions"]
    QS["query subscription"]
    DS["distinct subscription"]
    GAS["getAll subscription"]
  end

  UQ --> GA
  UQ --> GAA
  UQ --> QA
  UQ --> DA
  UQ -.-> QS
  UQ -.-> DS
  UQ -.-> GAS
```

---

## 7. Where to go next

| Topic | Document |
|--------|-----------|
| Mounting, hooks, auth | [client-guide.md](../guides/client-guide.md) |
| `startServer`, MongoDB, extensions | [server-guide.md](../guides/server-guide.md) |
| Exports and handler registration | [features.md](./features.md) |
| C2S queue, debounce, idempotent replay | [plans/client-to-server-synchronisation.md](../plans/client-to-server-synchronisation.md) |
| S2C mirror, ack, gating | [plans/server-to-client-synchronisation.md](../plans/server-to-client-synchronisation.md) |
| Auditor, storage, platforms | [plans/design.md](../plans/design.md) |
