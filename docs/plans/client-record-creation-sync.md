# Client record creation and server synchronisation

This document describes **how a new record is created on the client** and **how that creation reaches the server**, including online/offline behaviour and failure modes. It focuses on **create / first-time upsert** only (not updates, deletes, or subscription-driven merges from other clients). For **server→client** sync (`mxdbServerToClientSyncAction`, pending guards), see [server-to-client-synchronisation.md](./server-to-client-synchronisation.md). **Using the library:** [README.md](../README.md) · [guides/client-guide.md](../guides/client-guide.md).

> **Target replication path:** New creates (and edits) are **queued** and sent with **`mxdbClientToServerSyncAction`** per [client-to-server-synchronisation.md](./client-to-server-synchronisation.md). **`mxdbUpsertAction`**, **`mxdbSyncCollectionsAction`**, and the “immediate push” wording in **§§4–7** are **legacy**; keep the **local `DbCollection` / audit** behaviour in §2–§3, but read **§§4–7** as historical unless your fork still registers those actions.

## Mental model

1. **Local-first**: The client always commits to local SQLite (via a worker) and updates an **audit trail** before anything else.
2. **When online (target):** **`ClientToServerProvider`** **`enqueue`s** work; **`ClientToServerSynchronisation`** debounces and sends an **audit slice** via **`mxdbClientToServerSyncAction`**. (Legacy: per-change **`mxdbUpsertAction`**.)
3. **Source of truth for reconciliation:** The **audit** (and live row) is merged on the server; after a **successful C2S** response, the client runs **`collapseAudit`** for successful ids (phase B — see C2S spec). (Legacy: full **`mxdbSyncCollectionsAction`** cycle.)

---

## 1. Entry point: `upsert` from the app

Application code typically uses `useCollection(collection).upsert(record)` (see `createUpsert.ts`).

Before touching local storage, the hook **waits for any in-flight synchronisation** via `finishSyncing()` (from `SyncProvider`). That avoids applying a new local write on top of a sync that is mid-flight reconciling the same collection.

Then it calls `dbCollection.upsert(record)` on the client `DbCollection`.

**Edge cases**

- **`finishSyncing`**: If a sync is running, the upsert is queued behind it. If the socket disconnects while sync is pending, the sync waiter is released so the app does not hang forever.
- **Empty batch**: Upserting zero records logs a warning and returns.

---

## 2. Local write: `DbCollection.upsert`

Implementation: `src/client/providers/dbs/DbCollection.ts`.

For a normal user upsert (`auditAction === 'default'`):

1. **No-op**: If the new record is `deepEqual` to the cached row, the method returns **without** changing audit, persistence, or `onChange`. Nothing is queued for the server.
2. Otherwise the in-memory cache is updated.
3. **Audit**:
   - **New id** (no existing audit): `auditor.createAuditFrom(record)` → a single **`Created`** entry (with a new ULID id on that entry).
   - **Existing id**: The audit is updated with diff-based **`Updated`** entries (not the focus of this doc).
4. **Persistence**: Live row + audit rows are written to SQLite (`#persist`), asynchronously batched through the worker.
5. **`onChange`**: Subscribers receive `{ type: 'upsert', records: [record], auditAction: 'default' }`.

**`branched` upserts** (used when applying server reconciliation) rebuild the audit from a **`Branched`** anchor; those events are **not** pushed with the immediate upsert action (see below).

---

## 3. What “pending” means for a new record

`auditor.hasPendingChanges` (`src/common/auditor/api.ts`) treats an audit as pending if:

- There is no `Branched` entry: **any** entries count as pending (so a lone **`Created`** entry is pending), or  
- There is a `Branched` entry: any **`Updated` / `Deleted` / `Restored`** after that anchor counts as pending (a **`Branched`**-only audit is **not** pending).

So after you create a record, the client typically has **pending** changes until sync collapses the audit to a branch at the last server-acknowledged entry.

---

## 4. Online: immediate push (`ClientToServerProvider`)

`ClientToServerProvider` subscribes to each collection’s `onChange`.

On **`upsert`**:

- If **`!isConnected()`**, it **returns immediately** — no socket call. The record and audit remain local only.
- If **`auditAction === 'branched'`**, it **skips** the immediate action (sync/reconciliation path).
- Otherwise it calls **`mxdbUpsertAction`** with `{ collectionName, records }`, wrapped in a **5s timeout** (`ACTION_TIMEOUT_MS`).

On **success or failure** of that action, the client **does not** collapse audits locally. Comments in code state that **collapse happens after the next `mxdbSyncCollectionsAction` cycle** (`SyncProvider`).

**Edge cases**

- **Timeout or network error**: The error is swallowed; **audits stay intact** so the next **sync** can still send the full audit and reconcile.
- **Success**: MongoDB (or your server DB layer) has the row, but the client may still show **pending** until the next successful sync response triggers **`collapseAudit`** (see §6).

---

## 5. Server: `mxdbUpsertAction` (fast path)

Handler: `src/server/actions/upsertAction.ts` → `handleUpsert`.

1. Resolves the server `ServerDbCollection` for the name.
2. Loads **existing** rows for the ids in the payload (to classify **inserts vs updates** for extensions).
3. Runs optional **`onBeforeUpsert`** from collection extensions with `{ records, insertedIds, updatedIds }`.
4. Calls **`dbCollection.upsert(records)`** on the server.

`ServerDbCollection.upsert` (`src/server/providers/db/ServerDbCollection.ts`) performs a Mongo **`replaceOne` … `upsert: true`** for each record. If auditing is enabled for the collection, the audit is written in the **same transaction** as the records, before `upsert` resolves — a failure there rejects the upsert and nothing is written (sc-5480).

**Edge cases**

- **`onBeforeUpsert` throws or rejects**: The upsert does not proceed; the client still has local data + pending audit → **sync** can retry a different path or the user can retry.
- **`disableAudit` collections**: Live write still happens; audit behaviour on the server is reduced per config (client still builds audits for sync in current design).

---

## 6. Sync: `mxdbSyncCollectionsAction` (reconciliation)

Triggered when the socket **connects** (`onConnected`) and on a **2s poll** while connected **if** `db.hasPendingAudits()` is true. A **30s** timeout wraps the whole `synchroniseCollections` call per run.

Client driver: `src/client/providers/sync/synchronise-collections.ts`  
Server handler: `src/server/actions/syncAction.ts`

### 6.1 Client → server payload

For each collection, the client sends **`updates: audits`** where `audits` is **`getAllAudits()`** for that collection — i.e. **every** record’s audit document in the local DB, not only pending ones. Your **new record** is included as an `AuditOf` whose entries start with **`Created`**.

### 6.2 Server processing (`processUpdates`)

For each client audit:

1. **Merge** with the server’s stored audit if one exists (`audit.merge`), else adopt a cleaned copy of the client audit.
2. **Replay** merged entries with `createRecordFrom` to get the **materialised** live record (or tombstone if deleted).
3. Build **`results[id]`**:
   - If materialised record is **null** (deleted): result carries **`auditEntryId`** (and removal bookkeeping).
   - Else: compare **client-only replay** vs **merged replay** with `deepEqual`. If they match → **`{ auditEntryId }` only**; if not → **`{ auditEntryId, record: materialised }`** so the client can overwrite divergent local state.

4. **`dbCollection.sync({ updated, updatedAudits, removedIds })`**: Per-record transactional writes with retries; on **permanent** failure, `results[id].error` is set.

5. **Push to other clients** via `syncRecords` / `syncAuditFreeRecords` (real-time fan-out).

**Edge cases (creation-relevant)**

- **Invalid audit shape**: Logged; that id may get **no** usable result (nothing to collapse).
- **Merge throws**: Logged; same.
- **Replay throws**: Logged; same.
- **Unknown collection name**: Response has **`notFound: true`** → client **`clear('all')`** for that collection (destructive local reset).
- **Permanent I/O failure for one id**: Result includes **`error`**; client invokes **`onCollectionError`** with `IO_PERMANENT`; **local audit stays pending** for that record (`post-sync still pending` diagnostics may apply).

### 6.3 Client applies results

For each `result` (simplified for **create** scenarios):

- **`error`**: Notify error; **do not** replace local audit/record from server.
- **`record != null`**: **`upsert(record, 'branched', auditEntryId)`** — align local live row with server; re-anchor audit. Special case: if local audit **vanished** but server sent record + `auditEntryId`, same branched upsert.
- **`record == null` and `auditEntryId`**: **`collapseAudit(id, auditEntryId)`** — trims history to a **`Branched`** entry at the acknowledged id; keeps any entries **after** that anchor if they were added during a race (see below).

For a **simple new record** that the server accepted and matches the client, the server typically returns **only `auditEntryId`** (`inSync`), so the client **collapses** and pending clears.

**Race (still creation-related)**

- If the user adds **more audit entries after** the sync request was built but **before** the response is applied, and those entries are **newer** than both the snapshot and the server’s `auditEntryId`, the client **skips** overwriting that id (`skip-newer` diagnostic) so local unsynced work is preserved.

### 6.4 Sync transport failures

`syncCollection` is wrapped in **three retries** with exponential backoff. If all fail, **`onCollectionError`** with `SYNC_FAILED` fires. Local data is unchanged; the next **connect** or **poll** can try again.

If the **socket drops mid-sync**, waiters are released; a later run will send audits again.

---

## 7. Offline → online

1. **While offline**: Creates behave like §2; §4 does nothing for the immediate action.
2. **`hasPendingAudits()`** is true (for a new record: **`Created`** only).
3. When the socket **connects**, **`runSync('connected')`** runs.
4. While connected, the **poll** every 2s also runs sync **only if** pending audits exist — so a failed sync or missed ack can be retried without requiring a disconnect.

**If the server write eventually succeeds** (via fast upsert and/or sync): the client should receive results that **collapse** or **branched-upsert** local state; pending clears when the audit is only a **`Branched`** anchor (for the simple case).

**If the server repeatedly rejects or I/O-fails** that id: local data remains; **`IO_PERMANENT`** (or repeated **`SYNC_FAILED`**) surfaces via `onError` / `onCollectionError` depending on path.

---

## 8. End-to-end summary (new record)

| Phase | Online + healthy | Online + action fails | Offline |
|--------|------------------|------------------------|---------|
| Local | SQLite + `Created` audit | Same | Same |
| Immediate `mxdbUpsertAction` | Sent; server has row | Skipped on error; audit pending | Not called |
| Next sync | Sends audits; usually `collapseAudit` | Sends audits; server merge + write | On reconnect / poll |
| Pending cleared | After successful sync result | When sync succeeds | When sync succeeds |

---

## 9. Key source files

| Concern | File |
|--------|------|
| Hook waits for sync, calls upsert | `src/client/hooks/useCollection/createUpsert.ts` |
| Local SQLite + audit + `onChange` | `src/client/providers/dbs/DbCollection.ts` |
| Immediate socket upsert | `src/client/providers/client-to-server/ClientToServerProvider.tsx` |
| Sync scheduling, timeouts | `src/client/providers/sync/SyncProvider.tsx` |
| Build sync requests, apply responses | `src/client/providers/sync/synchronise-collections.ts` |
| Server upsert handler | `src/server/actions/upsertAction.ts` |
| Server sync merge / replay / writes | `src/server/actions/syncAction.ts` |
| Server Mongo upsert + `sync()` transactions | `src/server/providers/db/ServerDbCollection.ts` |
| Audit semantics (Created, Branched, pending) | `src/common/auditor/api.ts` |

---

## 10. Out of scope (not covered here)

- **Server change streams** pushing other clients’ inserts into this client.
- **Deletes**, **clear**, and **conflict** callbacks (`onConflictResolution`).
- **Concurrent creation of the same id** on two devices (handled by audit **merge** + replay, but full conflict story spans updates and deletes).

If this document drifts from behaviour, prefer the cited implementations over this text.
