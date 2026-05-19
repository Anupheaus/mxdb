# MXDB: Robust Sync Master Design Specification (Change Plan)

**Documentation map:** To **integrate** the library, use [README.md](../README.md) (client guide, server guide, features list, C2S/S2C specs). This document is the **long-form design** (auditor semantics, storage, WebAuthn/OPFS/Cordova, and change plan). Historical trackers live under [archive/](../archive/).

---

## 1. Executive Summary

MXDB utilizes a deterministic, ULID-anchored audit trail to synchronize state between clients and a MongoDB backend. The system prioritizes "Micro-Syncing" (sending only changes) over full record replacement, using a **Hybrid Anchoring** strategy to ensure array operations remain valid even when indices shift.

This document is also the **plan for changing the current library implementation** to match the behaviours described here. Where the current implementation differs, the requirements in this document take precedence.

### 1.1 Auditor implementation

The **auditor** (create/update/merge audit entries, materialise records from audit, apply ops, etc.) will be pulled in from the **common library** (`@anupheaus/common`) and maintained as an **in-repo version** within this library. That in-repo auditor will implement the behaviour described in this document (enums, audit structures, hybrid path anchoring, replay and conflict rules, idempotency, etc.), so that mxdb owns the sync semantics and can evolve them without depending on the common library’s auditor.

### 1.2 Target Platforms

This library is designed to run on:

- **Web browsers** (desktop and mobile): Chrome, Safari, Firefox, Edge.
- **Mobile and tablet apps** via **Apache Cordova**: The app runs inside a native WebView (Android WebView, iOS WKWebView). Cordova apps are single-window — multi-tab coordination (§4.9) is not a concern on mobile, but the underlying APIs must still work within the WebView environment.

**Platform compatibility considerations:**

| API | Web browsers | Cordova Android | Cordova iOS |
|-----|-------------|-----------------|-------------|
| **OPFS** (`createSyncAccessHandle`) | Chrome 102+, Safari 15.2+, Firefox 111+ | Android WebView 102+ | iOS 15.2+ (WKWebView) |
| **Web Workers** | All modern browsers | Supported; requires `https://localhost` scheme via WebViewAssetLoader (Cordova-Android 13+) | Supported |
| **SharedWorker** | Chrome, Firefox (not Safari) | Not available | Not available |
| **Web Locks API** | Chrome 69+, Safari 15.4+ | Available in WebView | Available in WKWebView |
| **BroadcastChannel** | Chrome 54+, Safari 15.4+ | Available in WebView | Available in WKWebView |
| **WebAuthn (PRF extension)** | Chrome 116+, Safari 18+ (iOS 18+) | Requires a Cordova plugin (see below) | Requires entitlement + iOS 18+ (see below) |
| **SQLite WASM + file encryption** | `@sqlite.org/sqlite-wasm` + AES-GCM on persisted DB | Supported | Supported |
| **COOP/COEP headers** | Configurable on server | Must be set on the local dev server or via Cordova config | Must be set via Cordova config |

**Key implications:**

- **SharedWorker is not available on Cordova or Safari.** The Web Locks + BroadcastChannel fallback (§4.9) is the primary mechanism on these platforms. On Cordova mobile (single window), the fallback degenerates to a simple dedicated Worker with no coordination needed.
- **Cordova-Android 13+ requires HTTPS scheme.** Web Workers loaded over `file://` are blocked. The app must use `https://localhost` via WebViewAssetLoader.
- **COOP/COEP headers** are needed for optimal OPFS performance (§4.3). On Cordova, these must be configured in the local server or native wrapper. If not available, OPFS may fall back to async access (slower but functional).
- **WebAuthn on Cordova requires platform-specific work.** `navigator.credentials` is not natively available in either Android WebView or iOS WKWebView without additional configuration. See the WebAuthn compatibility section below.

**WebAuthn + PRF on Cordova (detailed):**

WebAuthn with the PRF extension is critical to this library (§4.3, §4.4). On standard web browsers it works out of the box. On Cordova, both platforms have limitations:

- **Android WebView:** Google intentionally excludes `navigator.credentials` from Android WebView. However, `androidx.webkit` 1.12.0+ provides `WebSettingsCompat.setWebAuthenticationSupport()` which enables WebAuthn in WebView via the **Credential Manager API**. This requires:
  - Adding `androidx.credentials:credentials` (1.6.0+) and `androidx.webkit:webkit` (1.12.0+) as native dependencies.
  - Calling `setWebAuthenticationSupport(WEB_AUTHENTICATION_SUPPORT_FOR_APP)` on the WebView settings.
  - Configuring **Digital Asset Links** (`.well-known/assetlinks.json`) to associate the app with the domain.
  - A **custom Cordova plugin** is needed to perform these native setup steps. No existing off-the-shelf Cordova plugin provides WebAuthn + PRF support. The plugin must enable the Credential Manager bridge on the WebView at startup. Once enabled, `navigator.credentials.create()` and `navigator.credentials.get()` (including the PRF extension) become available to JavaScript in the WebView.

- **iOS WKWebView:** WebAuthn can work in WKWebView, but requires:
  - The **`com.apple.developer.web-browser.public-key-credential`** entitlement on the app.
  - **Associated Domains** configuration (`apple-app-site-association` on the server) linking the app to the RP ID domain.
  - iOS 18+ for PRF extension support.
  - With these in place, `navigator.credentials` (including PRF) is available in WKWebView. A Cordova plugin may be needed to configure the entitlement and ensure the WebView settings are correct, but the JavaScript API works natively once enabled.

- **Alternative — `ASWebAuthenticationSession` (iOS):** If WKWebView proves too restrictive, iOS offers `ASWebAuthenticationSession` which provides full Safari-equivalent WebAuthn support. This opens a system-managed browser sheet. A Cordova plugin could use this for the initial invite/registration flow and then fall back to WKWebView for normal operation (where only `credentials.get()` for sign-in is needed).

**Summary:** This library does not contain any Cordova-specific code. It uses standard Web APIs exclusively. If the app runs on Cordova, it is the **app's responsibility** to ensure those APIs are available in the WebView by installing the appropriate plugins and configuration. Specifically, the app needs a custom Cordova plugin for WebAuthn: on Android, it enables the Credential Manager WebView bridge; on iOS, it ensures the required entitlement and associated domains are configured. The plugin does not implement WebAuthn — it enables the native WebView's built-in support so the standard `navigator.credentials` API works. Once enabled, the library operates identically to a browser environment.

## 2. Core Data Models

### 2.1 Technical Enums

```typescript
export enum AuditEntryType {
  Created = 0,   // Full initial state
  Updated = 1,   // Partial updates (ops)
  Deleted = 2,   // Soft delete
  Restored = 3,  // Resurrection
  Branched = 4,  // Sync anchor/checkpoint (Lean pointer, no record payload)
}

export enum OperationType {
  Remove = 0,
  Replace = 1,
  Move = 2,
  Add = 3,
}

export enum TargetPosition {
  First = "FIRST",
  Last = "LAST",
}
```

### 2.2 Audit Structure Models

```typescript
export interface AuditOperation {
  type: OperationType;
  path: string; 
  value?: unknown;
  position?: TargetPosition;
  /**
   * The "Anchor Hash": SHA-256 (truncated) of the object 
   * BEFORE the change. Required ONLY for numeric index paths.
   */
  hash?: string; 
}

/**
 * AuditOf<RecordType> is the primary “audit container” for a record.
 * It contains the record id and an ordered history of immutable entries.
 */
export interface AuditOf<RecordType = any> {
  /** The record id this audit belongs to. */
  id: string;
  /** Numeric schema version for the AuditOf structure. */
  version: number;
  /**
   * Hash of the client's materialised record state after replaying this audit.
   * Computed per the Record Hash specification below. The server compares this
   * to its own materialised result; if they differ, the server sends the
   * corrected record and auditEntryId back to the client.
   */
  hash?: string;
  /** Immutable history entries ordered by ULID (or timestamp-derived ULID). */
  history: AuditEntry<RecordType>[];
}

export interface AuditCommonEntry {
  /**
   * Entry id: ULID (Universally Unique Lexicographically Sortable Identifier).
   * Client-side ULIDs are adjusted to Server-Time during generation.
   */
  id: string;
  recordId: string;
  /** Millisecond timestamp (derived from the ULID time component). */
  timestamp: number;
}

export interface AuditUpdateEntry extends AuditCommonEntry {
  type: AuditEntryType.Updated;
  ops: AuditOperation[];
}

export interface AuditCreatedEntry<RecordType = any> extends AuditCommonEntry {
  type: AuditEntryType.Created;
  record: RecordType; // Full state payload
}

export interface AuditBranchedEntry extends AuditCommonEntry {
  type: AuditEntryType.Branched;
  // Lean: No record field. Acts as a sync checkpoint pointer.
}

export type AuditEntry<RecordType = any> =
  | AuditCreatedEntry<RecordType>
  | AuditUpdateEntry
  | ({ type: AuditEntryType.Deleted } & AuditCommonEntry)
  | ({ type: AuditEntryType.Restored } & AuditCommonEntry)
  | AuditBranchedEntry;
```

### 2.3 Record Hash Computation

Record hashes are used for the `AuditOf.hash` field to detect state divergence between client and server during sync (§5.5). The server compares the client's declared hash against its own materialised result to determine whether a corrected record needs to be included in the sync response. Record hashes are **not** used for push filtering — the server pushes to all clients that have a record id (§5.6) and the client compares locally.

**Algorithm:** SHA-256, truncated to the first **16 hex characters (64 bits)** — the same truncation as anchor hashes (§3.2).

**Serialization:** The record is serialized to a **deterministic JSON string** before hashing. Deterministic means:

- Object keys are sorted lexicographically (recursively, at every nesting level).
- No whitespace (compact format).
- The record's `id` field IS included in the hash (it is part of the record).
- `undefined` values are omitted (as per `JSON.stringify` behaviour). `null` values are preserved.

**Both client and server MUST use the same serialization and hash algorithm.** The auditor implementation (§1.1) will provide a shared `hashRecord(record)` function used by both sides.

## 3. Hybrid Path Anchoring

### 3.1 Boxed ID Anchoring (Primary)

If an object within an array contains an `id` or `_id`, the path is "boxed" (e.g., `items.[id:abc]`). This is immune to array reordering.

### 3.2 Hash-Anchored Indexing (Fallback)

When an array element is anonymous (no `id` or `_id`), the path uses a numeric index. Because concurrent ops (adds, removes, moves) can shift indices, the engine cannot reliably apply an op by index alone. Hash-anchoring solves this.

**What the hash is:** Each op that targets a numeric index path includes a `hash` field: the first **16 hex characters (64 bits)** of the SHA-256 of the target object's content **before** the change (see §2.2 `AuditOperation.hash`). 64 bits provides a collision probability of ~1 in 2^32 per array (birthday bound), which is negligible for any realistic array size.

**How replay resolves the target:** When applying an op (e.g. `items.2` with `hash: "8a2f1c"`), the engine does *not* blindly use index 2. Instead, it locates the correct element by:

1. Taking the parent array (e.g. `items`) at the current materialised state.
2. Searching for an element whose content hash equals the op's `hash`.
3. Resolving the effective index to that element's position (which may differ from the original index if the array has shifted).
4. Applying the op at the resolved index.

**Why this matters:** If User A inserts at index 0 while User B edits the item that was at index 1, User B's op was recorded as `items.1` + hash. After User A's insert, that item is now at index 2. The hash lets the engine find it correctly.

**Failure case:** If no element in the array matches the hash (e.g. the item was removed, or content changed), the op cannot be applied. See §6.9 scenario 2 (Hash-anchored mismatch) for the chosen behaviour (ignore op).

### 3.3 Reordering Intent Race (The "Move" Problem)

§3.1 and §3.2 solve the **source** problem: how to find the element to operate on when the array has shifted (boxed ID or hash-anchored index). The **Move** op has an additional challenge: the **destination**. Where should the item go? A numeric index alone (e.g. "move to index 2") is ambiguous when concurrent ops have shifted the array—User B may have inserted at 0, so index 2 is no longer the intended position.

- **The Cause:** Concurrent moves or inserts change indices; a Move op that targets "index 2" may be wrong by the time it is replayed.
- **The Resolution:** `AuditOperation` supports a `position` enum (`First`, `Last`) so the destination expresses intent rather than a brittle index:
  - **`Move` + `First`:** Put the item at index 0. Intent-based; no index to corrupt.
  - **`Move` + `Last`:** Put the item at the end. Intent-based; no index to corrupt.

Arbitrary-position moves (e.g. "move to index 2") are not supported because the destination index is inherently fragile under concurrent modification. If the app needs finer-grained reordering, it should model order explicitly (e.g. a `sortOrder` field on each element) and use `Replace` ops to update those values.

## 4. Storage Architecture (MongoDB)

### 4.1 Dual-Collection Strategy

- **Live Collection:** Current materialized state for fast querying.
- **Audit Collection:** Immutable ledger of all `AuditEntry` objects.

### 4.2 Write Atomicity

Writes to both collections are wrapped in a **MongoDB Transaction** to ensure the live state never drifts from its history.

**Requirement:** All server-side sync writes that mutate (a) live records and (b) audit records MUST be performed in a single transaction. If the transaction fails, the server MUST not partially apply the sync.

### 4.3 Client Storage (SQLite + OPFS + encryption at rest)

Client-side storage uses **SQLite** on the **Origin Private File System (OPFS)** via **`@sqlite.org/sqlite-wasm`**. **Encryption is not SQLCipher inside the engine:** when a per-user key is available (e.g. derived via WebAuthn PRF), the worker keeps the database in memory for normal operation, serializes it after write transactions, encrypts the bytes with **AES-GCM** (fresh IV per write), and persists ciphertext to OPFS; on open, the file is decrypted and loaded back into SQLite. Without a key, a plain OPFS-backed database may be used (e.g. tests or local dev). This provides:

- **Full indexing:** Standard SQLite indexes and SQL; the encryption layer wraps the persisted file, not individual cells.
- **Tamper resistance:** At-rest data is ciphertext when a key is in use.
- **Performance:** OPFS with `createSyncAccessHandle()` enables strong SQLite performance in the worker (often much better than async IndexedDB).

**Architecture:**

- **Web Worker:** All database access (reads and writes) runs in a dedicated or shared worker. OPFS sync access requires a worker; keeping reads in the worker also prevents long queries from blocking the main thread.
- **OPFS VFS:** SQLite uses the OPFS virtual filesystem for persistent storage. Requires `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` for optimal (sync) performance.
- **Build:** Use the published **`@sqlite.org/sqlite-wasm`** package; no custom SQLCipher WASM build is part of this library.

**Record storage — JSON blob per row:** Each record is stored as a single row with two columns: `id TEXT PRIMARY KEY` and `data TEXT` (the full record serialized as JSON). This approach is resilient to record shape changes over time — no schema migrations are needed when fields are added, removed, or renamed. The `id` is extracted as a dedicated column for primary key lookups; all other field access uses `json_extract(data, '$.fieldPath')`.

Live and audit collections map to SQLite tables with the same dual-collection structure as the server (§4.1). For audit-free collections, the `_sync` table (§4.5) is created alongside the live table.

**Audit table schema (column-based):** Unlike live tables (JSON blob per row), the `_audit` table uses explicit SQLite columns because its structure is controlled by this library and unlikely to change. Using columns allows efficient indexing on `recordId` and ordering by `id` (ULID) without `json_extract`:

```sql
CREATE TABLE IF NOT EXISTS {collection}_audit (
  id          TEXT PRIMARY KEY,    -- audit entry ULID
  recordId    TEXT NOT NULL,       -- the live record this entry belongs to
  type        INTEGER NOT NULL,    -- AuditEntryType enum value
  timestamp   INTEGER NOT NULL,    -- millisecond timestamp (from ULID)
  record      TEXT,                -- JSON: full record payload (Created entries only)
  ops         TEXT                 -- JSON: array of AuditOperation (Updated entries only)
);
-- No FOREIGN KEY to _live: when a record is deleted, the live row is removed
-- but audit entries persist until synced and collapsed.

CREATE INDEX IF NOT EXISTS idx_{collection}_audit_by_record
  ON {collection}_audit(recordId, id);
```

**`_sync` table schema (column-based):** Similarly, the `_sync` table uses explicit columns:

```sql
CREATE TABLE IF NOT EXISTS {collection}_sync (
  id            TEXT PRIMARY KEY,    -- matches the live record id
  isDirty       INTEGER NOT NULL DEFAULT 0,  -- 0 = false, 1 = true
  lastUpdatedAt INTEGER,             -- millisecond timestamp (NULL if never updated)
  isDeleted     INTEGER NOT NULL DEFAULT 0   -- 0 = false, 1 = true
);
-- No FOREIGN KEY to _live: when a record is deleted offline, the live row is
-- removed but the _sync entry persists with isDeleted = 1 until synced.

CREATE INDEX IF NOT EXISTS idx_{collection}_sync_dirty
  ON {collection}_sync(isDirty) WHERE isDirty = 1;
```

The `isDirty` partial index enables fast lookup of all dirty records during sync without scanning the entire table.

**Expression indexes:** Indexes defined in `MXDBCollectionConfig` are created as **SQLite expression indexes** on `json_extract`. When the library processes `defineCollection`, it generates a `CREATE INDEX` statement for each declared index:

```sql
-- Single-field index
CREATE INDEX IF NOT EXISTS idx_todos_by_status
  ON todos_live(json_extract(data, '$.status'));

-- Compound index
CREATE INDEX IF NOT EXISTS idx_todos_by_userId_status
  ON todos_live(json_extract(data, '$.userId'), json_extract(data, '$.status'));

-- Unique index
CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_unique_slug
  ON todos_live(json_extract(data, '$.slug'));

-- Sparse index (WHERE NOT NULL)
CREATE INDEX IF NOT EXISTS idx_todos_by_dueDate
  ON todos_live(json_extract(data, '$.dueDate'))
  WHERE json_extract(data, '$.dueDate') IS NOT NULL;
```

SQLite uses these indexes automatically when the `WHERE` clause expression matches the index expression exactly. The `DataFilters → SQL` translator (see below) generates matching expressions.

**Query translation — `DataFilters` to SQL:** The current client uses `sift` to apply MongoDB-style `DataFilters` to in-memory arrays. This is replaced by a bespoke **`DataFilters → SQL WHERE clause` transformer** that translates filters directly into parameterized SQL, allowing SQLite to execute queries using its indexes and query planner.

**Operator mapping:**

| `DataFilters` operator | SQL equivalent | Example |
|---|---|---|
| `$eq` (or direct value) | `json_extract(data, '$.field') = ?` | `{ status: 'done' }` → `json_extract(data, '$.status') = 'done'` |
| `$ne` | `json_extract(data, '$.field') != ?` | |
| `$gt` | `> ?` | |
| `$lt` | `< ?` | |
| `$gte` | `>= ?` | |
| `$lte` | `<= ?` | |
| `$in` | `IN (?, ?, ...)` | |
| `$ni` | `NOT IN (?, ?, ...)` | |
| `$exists: true` | `json_extract(data, '$.field') IS NOT NULL` | |
| `$exists: false` | `json_extract(data, '$.field') IS NULL` | |
| `$like` | `LIKE ?` | |
| `$beginsWith` | `LIKE ? \|\| '%'` | `{ name: { $beginsWith: 'Jo' } }` → `LIKE 'Jo%'` |
| `$endsWith` | `LIKE '%' \|\| ?` | |
| `$regex` | Custom `REGEXP` function | Registered on the SQLite connection via `create_function` |
| `$or` | `(... OR ...)` | Parenthesized disjunction |
| `$and` | `(... AND ...)` | Parenthesized conjunction |
| `$all` | Multiple `EXISTS` with `json_each` | For array containment |
| `$elemMatch` | `EXISTS (SELECT 1 FROM json_each(...) WHERE ...)` | Subquery over array elements |
| `$size` | `json_array_length(json_extract(data, '$.field')) = ?` | |

**Parameterization:** All user-provided values MUST be passed as bound parameters (`?`), never interpolated into the SQL string. This prevents SQL injection and allows SQLite to cache query plans.

**Sorts and pagination:** `DataSorts` are translated to `ORDER BY json_extract(data, '$.field') ASC|DESC`. Pagination uses `LIMIT ? OFFSET ?`.

**Implementation:** The transformer is a pure function: `(filters: DataFilters<T>, tableName: string) → { sql: string; params: unknown[] }`. It is part of the library's client internals (not exported). The `sift` dependency is removed.

**Client-side write atomicity:** As with the server (§4.2), all client-side writes that mutate both the live table and the audit table for a record MUST be wrapped in a **SQLite transaction**. If the transaction fails, neither table is updated. This prevents the local live state from drifting from its audit history.

**WebAuthn onboarding and database setup:** MXDB requests WebAuthn (PRF extension) from within the library. One user may use multiple devices; this library does not manage multi-device registration—the app/server handles that. MXDB expects that, if it is a new user (no database found for the credential), user details are optionally passed in by the app. The decision logic:

1. **No database found for the user and no user details provided** → MXDB raises an error.
2. **No database found for the user and user details provided** → MXDB sets up a new database using the encryption key (derived from WebAuthn PRF) and stores the user details in the encrypted database.
3. **Database found for the user** → MXDB opens it using the WebAuthn credentials (derive key from PRF, open existing database).

The database is identified by the WebAuthn user handle (a short ID set at credential creation), so no enumeration or loop is required.

### 4.4 Invitation and Device Linking

This library provides the full invitation flow to link a user with a device credential. The app uses Universal Links or App Links (not custom URL schemes); the app must configure these (e.g. `apple-app-site-association`, `assetlinks.json`) and route invite URLs to the library's handler.

**1. Server: Create link.** The app server calls this library to create an invitation link:

- **Input:** `userId` (provided by the app server).
- **Library:** Creates a record in `mxdb_authentication` with `requestId` (ULID) and `userId`. The caller provides the `domain` as an argument (see §7.4) to build the link. TTL is a configuration option; the server uses the timestamp encoded in the ULID to validate whether the link was used within the configured timeframe.
- **Output:** Returns the link (e.g. `https://{domain}/invite/{requestId}`) for the app to send via email, WhatsApp, etc.

**2. Client: Handle the link.** The library provides a handler that the app invokes when the user opens an invite link (app routes to the handler component/hook):

- **Detection:** When the URL contains the invite path (e.g. `/invite/{requestId}` or `?invite={requestId}`), the library runs the flow.
- **WebAuthn:** Registers a new WebAuthn credential on this device via `navigator.credentials.create()` with the PRF extension. This generates a new credential (key pair) and derives the PRF-based encryption key. For subsequent sign-ins on the same device, `credentials.get()` is used instead (see §4.8).
- **Request:** Sends a request to the server with the `requestId` from the link and device details (e.g. credential id, user agent, or other device fingerprint the library collects).
- **Server:** Looks up `mxdb_authentication` by `requestId`. Validates the request (see **Invite link security** below). Calls an app-provided callback to get user details for the `userId`. Generates a ULID authentication token (see **Authentication token format** below). Updates the record with device details, token (`currentToken`), and `isEnabled: true`. Returns the user details and authentication token in the response.
- **Client:** Receives the response. Creates a new database using the WebAuthn credentials already obtained (PRF key for encryption, user handle for DB id). Stores the authentication token in the internal `mxdb_authentication` table within the encrypted database. Invokes an app-provided callback so the app can persist the user details into the encrypted database in its chosen format.
- **Future connections:** The client uses the authentication token stored in the encrypted database to authenticate with the server (see §5.1).

**Invite link security:**

- **Single-use:** Each `requestId` is single-use. Once a client submits a request against a `requestId`, it is consumed regardless of outcome:
  - **Successful authentication:** The record is populated with device details, token, and `isEnabled: true`. Any subsequent attempt using the same `requestId` is rejected (the record already has device details and a token).
  - **Failed authentication** (e.g. invalid device details, server-side validation failure): The record is marked `isEnabled: false`. Any subsequent attempt using the same `requestId` is rejected (the record is disabled).
- **TTL:** The server validates that the ULID timestamp of the `requestId` is within the configured TTL. Expired links are rejected before any further processing.
- **Rate limiting:** The server MUST enforce rate limiting on the invite redemption endpoint to prevent brute-force attacks against `requestId` values. Rate limiting applies per source IP address: after a configurable number of failed attempts (e.g. 5) within a time window (e.g. 15 minutes), further requests from that IP are rejected with a rate-limit error. The threshold and window are configuration options.

**Authentication token format:** The authentication token is a **ULID**. The first token is generated by the server when a device completes the invitation flow; subsequent tokens are generated during token rotation (see below). The server looks up the token in `mxdb_authentication` to validate it and derive the userId — no signing or decoding is needed. The ULID's embedded timestamp is also used for clock drift calculation (§5.2). This avoids JWT signing key management entirely.

**Token rotation (two-phase):** Authentication tokens are **ULIDs** — each token embeds the timestamp of when it was issued, eliminating the need for separate timestamp columns. Tokens are rotated on every connection using a two-phase protocol to prevent lockout if the client crashes mid-rotation:

1. The server validates the incoming token against `currentToken` (or, during the grace window, `pendingToken`) on the `mxdb_authentication` record.
2. If valid, the server generates a new ULID token. It writes `currentToken = <new ULID>` and `pendingToken = <old token>`. The `pendingToken` ULID's embedded timestamp marks when it was issued; the server compares this against a configurable **grace period** to determine if it is still valid.
3. The server sends the new token (`currentToken`) to the client.
4. The client stores the new token in its encrypted database, replacing the old one, and sends an acknowledgement to the server.
5. On receiving the ack, the server sets `pendingToken = null` — the new token is now the only valid one.
6. If no ack arrives within the grace period, the server reverts: `currentToken = pendingToken`, `pendingToken = null` (assumes the client did not receive or store the new token).

During the grace window, the server accepts **either** `currentToken` or `pendingToken`. This limits the window of exposure for a stolen token — it is only usable until the legitimate user's next connection. If a stolen token is used first, the legitimate user's next connection will fail (their token is now stale), alerting the system to potential compromise; the admin can then disable the device.

**Grace period edge case:** If the client receives and stores the new token, sends the ack, but the ack is lost (e.g. network drop), and the client remains offline for longer than the grace period, the server reverts to the old token and discards the new one. The client now has a token the server no longer recognises — the client is locked out. This is an accepted trade-off for security. The recovery path is for the admin to disable and re-invite the device (§4.8). In practice, this requires the client to go offline at the exact moment between storing the token and the server receiving the ack, AND remain offline for the entire grace period — a narrow window. The grace period should be configured generously (default 60 seconds) to minimise this risk.

**Token lifetime and device revocation:** The library provides the app server with APIs to: (a) **get device information per userId**, and (b) **enable or disable a specific device for a userId**. When a device is disabled (`isEnabled: false`), its token is rejected. The server rejects any sync or connection request using a token for a disabled device. The user would need the admin to re-enable the device (or create a new invite) to regain access on that device.

**Internal tables:**

- **Server (MongoDB):** `mxdb_authentication` — `requestId` (ULID), `userId`, optional `deviceDetails`, optional `currentToken` (ULID), optional `pendingToken` (ULID), `isEnabled` (boolean). An unauthenticated record has no device details or tokens; an authenticated record has at least `currentToken`. During two-phase rotation, both `currentToken` and `pendingToken` are present — the ULID timestamps embedded in the tokens define when each was issued; the server uses a configurable grace period to determine when to expire the old token or revert the pending one if unacknowledged. TTL for unauthenticated invite records is also a configuration option — the server uses the ULID timestamp of the `requestId` to determine if the invite was used within the timeframe.
- **Client:** `mxdb_authentication` — internal table (within the encrypted DB) storing the current authentication token. Only one user can open this database, so no keying is required.

**Callbacks:**

- **Server:** `onGetUserDetails(userId)` — app provides user details (name, email, etc.) for the given userId. The return type is app-defined (`unknown` from the library's perspective) — the library passes it opaquely to the client.
- **Client:** `onSaveUserDetails(userDetails)` — app persists user details into the encrypted database (library has already created the DB and stored the token; app decides how to store the user record). The `userDetails` value is whatever the server's `onGetUserDetails` returned — the library does not interpret it.

### 4.5 Collection Definitions

Collections are defined by the app and handed to the library on both the server and the client. The app calls `defineCollection()` for each collection, providing a `MXDBCollectionConfig`:

```typescript
/**
 * Recursive dot-notation key path type. Resolves nested properties,
 * e.g. for { address: { city: string } } produces 'address' | 'address.city'.
 */
type NestedKeyOf<T> =
  T extends object
    ? { [K in keyof T & string]:
        K | `${K}.${NestedKeyOf<T[K]>}`
      }[keyof T & string]
    : never;

export interface MXDBCollectionIndex<RecordType extends Record = Record> {
  name: string;
  fields: NestedKeyOf<RecordType>[];
  isUnique?: boolean;
  isSparse?: boolean;
}

export type MXDBSyncMode = 'Synchronised' | 'ServerOnly' | 'ClientOnly';

export interface MXDBCollectionConfig<RecordType extends Record = any> {
  name: string;
  indexes: MXDBCollectionIndex<RecordType>[];
  syncMode?: MXDBSyncMode;
  disableAudit?: boolean;
}
```

**`syncMode`** (default: `'Synchronised'`):

- **`Synchronised`** — The collection exists on both client and server. Records that exist on both sides are kept in sync via the audit trail. This does NOT mean all records exist in both places — only that overlapping records are synchronised.
- **`ServerOnly`** — The collection exists only on the server. No client-side storage is created. Useful for server-managed reference data or aggregation tables that the client never accesses directly.
- **`ClientOnly`** — The collection exists only on the client. No server-side storage is created and no sync is attempted. Useful for local preferences, drafts, or caches.

**`disableAudit`** (default: `false`):

When `true`, no `_audit` table is created for this collection. Changes to records are applied immediately (direct writes) rather than recorded as audit entries. This is suitable for collections where change history is unnecessary (e.g. ephemeral caches, settings).

**Sync without audit — the `_sync` collection:** If `syncMode` is `Synchronised` and `disableAudit` is `true`, the collection is still synchronised between client and server, but without the audit trail. Instead of an `_audit` table, the library maintains a **`_sync`** table alongside the live table.

**`_sync` record structure (client-side):**

```typescript
interface SyncRecord {
  id: string;              // matches the live record id
  isDirty: boolean;        // true if locally modified and not yet synced
  lastUpdatedAt?: number;  // millisecond timestamp of the local modification (adjusted for clock drift per §5.2)
  isDeleted?: boolean;     // true if the record was deleted locally while offline
}
```

**`_sync` record structure (server-side):**

```typescript
interface SyncRecord {
  id: string;              // matches the live record id
  lastUpdatedAt?: number;  // millisecond timestamp of when the server last accepted an update for this record
}
```

**How it works:**

**Writes (client-side):**
- When the client modifies a record and is **connected**, the update is sent to the server immediately (full record + `lastUpdatedAt`). On successful ack, `isDirty` remains `false`.
- When the client modifies a record and is **offline**, the library sets `isDirty: true` and `lastUpdatedAt` (millisecond timestamp, adjusted for clock drift per §5.2) on the `_sync` record. Multiple offline edits to the same record update the `lastUpdatedAt` each time.
- When the client deletes a record while **offline**, the live record is removed but the `_sync` entry is kept with `isDirty: true`, `lastUpdatedAt`, and `isDeleted: true`.

**Sync on reconnection (client → server):**
1. The client sends all `_sync` records where `isDirty: true`: each includes the full live record (or `isDeleted: true` if deleted) and `lastUpdatedAt`.
2. For clean records (not dirty), the client sends the record `id` and `lastUpdatedAt` — no record payload.

**Server processing:**
- **Dirty record received (full record + `lastUpdatedAt`):**
  - Server compares the client's `lastUpdatedAt` with its own `_sync.lastUpdatedAt` for that record.
  - If the client's is **newer** (or the server has no record): server accepts the client's version, updates the live record and `_sync.lastUpdatedAt`. Returns an ack.
  - If the server's is **newer**: server returns its current live record and `_sync.lastUpdatedAt` in the response. The client replaces its local record with the server's version.
- **Dirty delete received (`isDeleted: true` + `lastUpdatedAt`):**
  - Same timestamp comparison. If the delete is newer, server removes the record from live and `_sync`. Returns an ack.
  - If the server's `lastUpdatedAt` is newer (someone updated the record after the delete), server returns the record to the client (un-deleting it).
- **Clean record received (id + `lastUpdatedAt`):**
  - Server compares the client's `lastUpdatedAt` with its own `_sync.lastUpdatedAt` for that record.
  - If the server's is **newer**: server returns its current live record and `_sync.lastUpdatedAt` in the response. The client updates its local record and `_sync.lastUpdatedAt`.
  - If the server's is **not newer** (equal or older): no action — the response contains nothing for this id.
  - If the server does not have this record at all (deleted by another client): server responds with the `id` and `isDeleted: true`. The client deletes both the live record and the `_sync` entry locally.

**Client handling the sync response:**
- **Ack (no record returned):** Clear `isDirty` on the `_sync` record.
- **Server sends a newer record:** Replace the local live record, update `lastUpdatedAt` on `_sync` to the server-provided value, clear `isDirty`.
- **Server responds with `isDeleted: true`:** Delete the local live record and `_sync` entry.

**Server push (ongoing, while connected):**
- When another client updates a record, the server pushes the updated record to all connected clients that have that record (see §5.6 for the per-client record id tracking). No hash comparison — the push goes to every client that has the record.
- **Client receives a push while `isDirty: true`:** Ignores the push and instead syncs that specific record with the server (the local version might be newer).
- **Client receives a push while `isDirty: false`:** The client compares the received record against its local copy. If they differ, the client updates the local record and `_sync.lastUpdatedAt`. If identical, the push is discarded — no write to the local database.

**No merge replay.** Conflict resolution is at the full-record level (last-write-wins by `lastUpdatedAt`). This is acceptable for collections where audit-free simplicity is preferred. No hashing is needed during sync — the `isDirty` flag and `lastUpdatedAt` timestamp are sufficient to determine what needs to be sent and who wins.

Collection definitions are hardcoded by the app — the same set of definitions is provided to both the server and the client. The library creates the underlying storage based on these definitions: on the server, MongoDB collections are created for `Synchronised` and `ServerOnly` collections; on the client, SQLite tables are created for `Synchronised` and `ClientOnly` collections. `ServerOnly` collections are skipped on the client; `ClientOnly` collections are skipped on the server.

**Wrong-side access:** If `useCollection` is called with a collection whose `syncMode` does not apply to the current side (e.g. calling `useCollection(serverOnlyCollection)` on the client, or `useCollection(clientOnlyCollection)` on the server), the library MUST throw an error immediately. The error message should clearly state the collection name and its `syncMode`. This is a programming error by the consuming app and should fail fast rather than silently returning empty results.

**Client-side setup timing:** Collections are set up when the app loads, but because the client database is encrypted (§4.3), setup can only happen after the user has authenticated via WebAuthn and the database has been opened. On first setup the collections are empty — this is expected. The client populates them on-demand via reactive subscriptions as the app requests data (see §5.9).

**Server-side setup:** The server creates or ensures MongoDB collections (live + audit per §4.1) based on the definitions on startup. Collections that already exist are left as-is; new indexes are created if missing.

### 4.6 Server-Side Data Encryption

Client data is encrypted at rest per §4.3 (application-layer encryption of the persisted database file). Server-side data in MongoDB should also be protected. The library does not mandate a specific approach, but the app MUST configure one of the following:

- **MongoDB Encrypted Storage Engine (Enterprise):** Transparent encryption of all data files at the storage layer. Requires MongoDB Enterprise.
- **MongoDB Client-Side Field Level Encryption (CSFLE):** Available from MongoDB 4.2+. Encrypts sensitive fields before they leave the application. The library can integrate CSFLE if the app provides the encryption key configuration.
- **MongoDB Queryable Encryption:** Available from MongoDB 6.0+. Allows querying encrypted fields without decrypting them server-side.
- **Disk-level encryption:** The host operating system encrypts the volume where MongoDB data resides (e.g. LUKS on Linux, BitLocker on Windows, FileVault on macOS). Simplest to configure; protects against physical disk theft but not against a compromised OS.

The choice depends on the app's threat model and MongoDB edition. At minimum, disk-level encryption SHOULD be enabled. For higher sensitivity, CSFLE or Queryable Encryption provides field-level protection even if the database server is compromised.

### 4.7 Transport Security

All communication between client and server MUST use **secure WebSockets (WSS)**. Plain HTTP or unencrypted WebSocket (WS) connections MUST be rejected. This applies to:

- The invitation/device-linking flow (§4.4)
- Token validation and rotation (§4.4, §5.1)
- Sync requests and responses (§5.4, §5.5)
- Server push updates (§5.6)
- On-demand data subscriptions (§5.9)

The server MUST be configured with a valid TLS certificate. The library does not manage certificates — the app server is responsible for TLS termination (directly or via a reverse proxy).

### 4.8 Sign-Out, Credential Loss, and Multi-User Devices

**Sign-out:** When a user signs out, the library closes the encrypted database, disconnects the WebSocket, and clears all in-memory state. The database file remains on disk (as permanent as the storage allows) — it is not deleted. The authentication token is stored only within the encrypted database, so it is inaccessible after sign-out without re-authenticating. To sign back in, the user must re-authenticate via WebAuthn biometrics (`credentials.get()` with PRF), which re-derives the encryption key and reopens the database.

**Sign-out across tabs:** If multiple tabs are open (§4.9), sign-out in any tab triggers the SharedWorker (or leader in the fallback) to close the database and disconnect. The SharedWorker broadcasts a "signed-out" event to all connected tabs via their `MessagePort` channels, so every tab can update its UI (e.g. redirect to a login screen). No tab retains access to the database after sign-out.

**Credential / device loss:** If a user loses their WebAuthn authenticator (e.g. phone destroyed, laptop stolen), their local encrypted database on that device is inaccessible. The admin MUST disable the device on the server (via the device management APIs in §4.4). The user can be re-invited on a new device — the server still has all their data, and the new device will receive it on-demand via the normal sync/subscription mechanism (§5.9). Data on the lost device remains encrypted and unreadable without the WebAuthn credential.

**Multi-user per device:** Multiple users can use the same physical device. Each user has their own encrypted database, identified by their WebAuthn user handle (§4.3). Switching users requires the current user to sign out (closing their database) and the next user to sign in via WebAuthn biometrics (opening their database). There is no concurrent multi-user access on a single device — one user is active at a time.

**No shared data:** Each user's database is independent. Two users may have records that represent the same logical data, but each user's copy is stored and synced separately. This is a deliberate design decision — there are no shared collections or cross-user record references.

### 4.9 Multi-Tab Coordination

OPFS `createSyncAccessHandle()` requires exclusive access to a file, so only one context can hold the database open at a time. If the user opens the app in multiple browser tabs, they must coordinate to avoid conflicts. On Cordova mobile/tablet (single WebView), multi-tab is not applicable — a simple dedicated Worker is sufficient.

**Approach: SharedWorker (where available).** On browsers that support it (Chrome, Firefox — not Safari, not Cordova WebViews), all database access runs through a **SharedWorker** — a single worker instance shared across all tabs of the same origin. The SharedWorker owns the database connection (SQLite over OPFS) and handles all reads, writes, and sync operations. Tabs communicate with the SharedWorker via `MessagePort`, sending requests (e.g. query, upsert, delete) and receiving responses.

- **Single connection:** Only the SharedWorker maintains the WebSocket connection to the server and runs the sync lifecycle.
- **Tab lifecycle:** When a tab opens, it connects to the existing SharedWorker (or starts one if none exists). When all tabs close, the SharedWorker is terminated by the browser — no explicit cleanup is needed.

**Fallback: Web Locks + BroadcastChannel.** On Safari, Cordova, and other environments without SharedWorker, the library falls back to a dedicated Worker per tab with the **Web Locks API** (`navigator.locks.request()`) for leader election. One tab acquires the lock and becomes the leader (owns the DB and sync connection). Other tabs communicate with the leader via **BroadcastChannel**. If the leader tab closes, another tab acquires the lock and takes over.

**Cordova (single window):** On Cordova mobile/tablet, there is only one WebView. The library uses a dedicated Worker directly — no leader election or cross-tab coordination is needed. The Worker owns the database and WebSocket connection.

## 5. The Sync Lifecycle

### 5.1 Client-to-Server Authentication

The server must know which user is syncing. The client authenticates using an **opaque authentication token** obtained via the invitation and device-linking flow (§4.4). WebAuthn is used only to open the local encrypted database — it is not used for server authentication directly.

**Connection flow:**

1. **Open database:** The user authenticates via WebAuthn biometrics. The library derives the encryption key (PRF) and opens the encrypted database.
2. **Read token:** The library reads the current authentication token from the `mxdb_authentication` table in the encrypted database.
3. **Connect:** The client opens a secure WebSocket (§4.7) connection to the server, presenting the token as an `Authorization: Bearer <token>` header in the HTTP upgrade request. This ensures the token is validated before the WebSocket connection is established and avoids exposing it in URL query parameters (which may appear in server logs and proxy logs).
4. **Server validates:** The server looks up the token in `mxdb_authentication`, verifies `isEnabled: true`, and derives the `userId` and device identity from the record.
5. **Token rotation + clock drift:** On successful validation, the server generates a new ULID token, sets `currentToken = <new ULID>`, `pendingToken = <old token>`, and sends the new token to the client. The client stores the new token in its encrypted database (see §4.4 Token rotation). Because the new token is a ULID, its embedded timestamp represents the server's current time at the moment of generation. The client extracts this timestamp and uses it to calculate clock drift (see §5.2).
6. **Rejection:** If the token is invalid or the device is disabled, the server rejects the connection. The user would need the app admin to re-enable the device or create a new invitation link.

**Server responsibility:** Validate the token on every connection. Reject tokens for disabled devices. Derive userId from the `mxdb_authentication` record. Audit entries do not carry userId — the user is implicit from the authenticated connection.


### 5.2 Clock Drift

Clock drift is derived from the authentication token — no separate handshake step is required. Since the token is a ULID generated by the server during token rotation (§5.1 step 5), its embedded timestamp represents the server's time at the moment of generation. The client extracts this timestamp upon receiving the new token and computes drift immediately.

Drift is recalculated on every connection (including reconnections) because the client's clock may have shifted (e.g. sleep/wake, NTP adjustment, timezone change).

- **Calculation:** `drift = Date.now() - extractTimestamp(newToken)`.
- **ULID Generation:** Client-side ULIDs use `seedTime = Date.now() - drift`.

This piggybacks on an exchange that already happens on every connection, avoiding a dedicated clock-sync round trip.

### 5.3 Server Side (Merging & Materialization)

1. **Interleaving:** Fetch server-side entries since the client's anchor, merge with the client's incoming entries, and sort the combined set by ULID. Because ULIDs are globally ordered (client ULIDs are adjusted for clock drift per §5.2), the interleaved sequence reflects causal order. Last-write-wins (§6.1) is resolved naturally by ULID ordering.
2. **Replay Logic:**
  - **Creation mid-stream:** If a `Created` (Type 0) entry is encountered mid-stream (e.g., after a reset), the materializer **ignores** it and continues with the existing state. It does not discard previous state or restart with the provided `record`.
  - **Splice Intent:** `Add` ops perform a **splice/insert**. `Replace` performs an index-set.
  - **Path Integrity:** If a parent path segment is missing, the operation is **Silently Dropped**.
3. **Concurrency:** When two clients sync the same record simultaneously, the server serialises merges per record using the MongoDB transaction (§4.2). If two transactions conflict on the same record, one will abort and retry (§6.9 row 14). This ensures a consistent merge order.

### 5.4 Sync Request Contract

Sync requests are per-collection. The client sends only **collectionName** and **updates**. Each audit in `updates` already carries the record id and full history (including any branch entry), so the server has everything it needs to reconcile and need not receive a separate list of ids or markers.

Proposed request shape (audited collections):

```typescript
export interface MXDBSyncRequest<RecordType extends Record = any> {
  collectionName: string;
  /**
   * Audit payloads for records the client wants to sync. Each AuditOf has id and
   * history (e.g. branch entry, pending ops, or recovery Created). The server
   * uses these to merge, materialise, and respond with per-id results.
   */
  updates: AuditOf<RecordType>[];
}
```

**Audit-free sync request** (collections with `disableAudit: true`):

```typescript
export interface MXDBSyncAuditFreeRequest<RecordType extends Record = any> {
  collectionName: string;
  /**
   * Dirty records: locally modified and not yet acknowledged by the server.
   * Each includes the full record (or isDeleted if removed) and the lastUpdatedAt timestamp.
   */
  dirty: MXDBSyncAuditFreeDirtyRecord<RecordType>[];
  /**
   * Clean records: unchanged locally. The server uses lastUpdatedAt to determine
   * if it has a newer version to send back.
   */
  clean: MXDBSyncAuditFreeCleanRecord[];
}

export interface MXDBSyncAuditFreeDirtyRecord<RecordType = any> {
  id: string;
  record?: RecordType;       // present if the record still exists locally
  lastUpdatedAt: number;     // millisecond timestamp (adjusted for clock drift)
  isDeleted?: boolean;       // true if the record was deleted locally
}

export interface MXDBSyncAuditFreeCleanRecord {
  id: string;
  lastUpdatedAt: number;     // millisecond timestamp from the _sync table
}
```

### 5.5 Sync Response Contract (Per-Id Outcomes)

Sync responses MUST include enough information for the client to decide, per record id, whether:

- the id was **acknowledged** (client may collapse local audit to a branch entry), or
- the id requires a **correction** (server's materialised state differs from the client's hash — the corrected record is included).

The sync response delivers materialised records directly to the syncing client. When the server merges the client's audit and materialises the result, it compares the final hash against the client's declared hash (from the `AuditOf.hash` field). If they differ, the server includes the corrected record in the response. The server MUST update its per-client record id set (§5.6) to include all record ids from the response, so the server knows which records this client has for future push decisions.

Proposed response shape:

```typescript
export interface MXDBSyncIdResult<RecordType = any> {
  id: string;
  /**
   * The ULID that represents the server's latest branch/checkpoint for this id.
   * The client should store this in the local branch entry for future syncs.
   */
  auditEntryId?: string;
  /**
   * Present when the server's materialised record differs from the client's
   * declared hash. The client MUST replace its local record with this value.
   * Absent when hashes match (the client's local state is already correct).
   */
  record?: RecordType;
}

export interface MXDBSyncResponse<RecordType = any> {
  collectionName: string;
  results: MXDBSyncIdResult<RecordType>[];
}
```

**Client handling of the sync response (per result):**

1. **`record` present** — replace the local record with the server's record, then collapse local audit (see collapse rules in §5.6 rule 3).
2. **`record` absent, `auditEntryId` present** — the client's hash matched; collapse local audit (§5.6 rule 3). No record replacement needed.
3. **Records the client does not have** — the server MAY include records in the response that the client did not send (e.g. records created by other clients that affect records the client synced). The client treats these as new: insert the record locally and create a branch entry with the provided `auditEntryId`.

**Audit-free sync response:**

```typescript
export interface MXDBSyncAuditFreeIdResult<RecordType = any> {
  id: string;
  /** Present when the server has a newer version. Client replaces its local record. */
  record?: RecordType;
  /** Server's lastUpdatedAt for this record. Client updates _sync.lastUpdatedAt. */
  lastUpdatedAt?: number;
  /** True if the record was deleted on the server. Client removes the live record and _sync entry. */
  isDeleted?: boolean;
}

export interface MXDBSyncAuditFreeResponse<RecordType = any> {
  collectionName: string;
  results: MXDBSyncAuditFreeIdResult<RecordType>[];
}
```

**Client handling of the audit-free sync response (per result):**

1. **No `record`, no `isDeleted`** — ack. Clear `isDirty` on the `_sync` record.
2. **`record` present** — server has a newer version. Replace the local record, update `_sync.lastUpdatedAt` to the server-provided value, clear `isDirty`.
3. **`isDeleted: true`** — record was deleted on the server. Delete the local live record and `_sync` entry.

### 5.6 Server-to-Client Push Updates (Branch ULID Protocol)

When the server pushes an updated record to a client (e.g. `mxdbServerPush` / watch-driven updates), the pushed payload differs depending on whether the collection is audited or audit-free.

**Audited push payload:** Includes the materialised record and the server's latest audit entry id.

```typescript
export interface MXDBServerPushAuditedRecord<RecordType = any> {
  record: RecordType;
  auditEntryId: string;
}

export interface MXDBServerPushAuditedPayload<RecordType = any> {
  collectionName: string;
  records: MXDBServerPushAuditedRecord<RecordType>[];
  removedIds: string[];
}
```

**Audit-free push payload:** Includes only the materialised record — no audit entry id.

```typescript
export interface MXDBServerPushAuditFreeRecord<RecordType = any> {
  record: RecordType;
}

export interface MXDBServerPushAuditFreePayload<RecordType = any> {
  collectionName: string;
  records: MXDBServerPushAuditFreeRecord<RecordType>[];
  removedIds: string[];
}
```

**Server push and per-client record tracking:** The server tracks which record ids each connected client has, per collection. This is a simple **`Map<clientId, Set<recordId>>`** held **in memory** — not persisted. The set is populated when a client connects and syncs (§5.10): every record id the client sends (whether dirty or clean) is added to the set. The set is updated when:

- The server sends a new record to the client (via sync response or push) → add the id.
- The server sends a removal to the client → remove the id.
- The client syncs a new record → add the id.
- The client disconnects → discard the entire set for that client.

When a record changes (detected via **MongoDB Change Streams** on the live collections), the server pushes the updated record to **every connected client that has that record id** in its set. No hash comparison is performed server-side — the push goes to all clients that have the record. The client performs its own comparison locally and discards the update if nothing changed. This means the originating client (the one that caused the change via sync) may receive the same update back via push, but the client-side comparison is trivial and avoids an unnecessary local write.

**Push payload:** For audited collections, the server sends an `MXDBServerPushAuditedPayload` (record + `auditEntryId`). For audit-free collections, the server sends an `MXDBServerPushAuditFreePayload` (record only, no `auditEntryId`).

**Client handling rules when a pushed update is received:**

**For audited collections:**

1. **If the client has no local audit history** for that record id (audit consists of only a branch entry), the client MUST:
  - Compare the pushed record against its local copy. If identical, discard the push.
  - Otherwise, replace the local record with the pushed record and update the branch entry to store the pushed `auditEntryId`.
2. **If the client has local audit history** (pending local changes beyond the branch entry), the client MUST:
  - Ignore the pushed record update, and
  - Sync by sending its current audit to the server (so the server merges).
3. **Audit collapse after sync acknowledgement:** After a successful sync response (§5.5), the client MUST collapse local audit entries for that record. The collapse MUST only remove entries up to and including the last entry the client sent to the server (identified by its ULID). Any entries created after the sync request was dispatched MUST be preserved — they represent unsent local changes that still need to be synced. After collapse, the oldest remaining entry is a branch entry whose ULID equals the last-sent entry's ULID. If newer (unsent) entries exist after the branch, the client should schedule another sync.
4. **When the client receives an id in `removedIds`:** If the record has local audit history (other than only a branched entry), the client MUST push that audit to the server first. On successful acknowledgement, the client removes the record and audit locally. If no audit exists except the branch entry, remove immediately.

**For audit-free collections (using `_sync`):**

1. **If `isDirty: false`** on the `_sync` record: Compare the pushed record against the local copy. If different, update the local record and `_sync.lastUpdatedAt`. If identical, discard.
2. **If `isDirty: true`** on the `_sync` record: Ignore the push. Trigger a sync for that specific record — the local version may be newer (see §4.5).
3. **When the client receives an id in `removedIds`:** If `isDirty: true` on the `_sync` record, the client MUST sync that record with the server first (the local version may be newer and should un-delete). On successful acknowledgement, the client follows the server's response (ack = record survives, `isDeleted` = remove locally). If `isDirty: false`, remove the live record and `_sync` entry immediately.

**Convergence:** After the server processes a sync, the Change Stream fires for any mutated records. The server pushes to all clients that have those record ids. Each client applies or discards based on its local state. The system converges because: clients with no local changes accept the update; clients with local changes sync their version, and the server resolves by timestamp (last-write-wins).

### 5.7 Collection Sync Isolation, Retries, and Reconnection

Collection syncs MUST remain separate. If syncing a collection fails (timeout/network/server error), the client MUST retry that collection a small number of times (e.g. 3 attempts with backoff). If it still fails, the client MUST surface an error to the user, while allowing other collections to continue syncing independently.

**WebSocket reconnection** (exponential backoff, max retries, etc.) is already handled by the underlying socket library (`nexus` / WebSocket layer) used by this library. The reconnection strategy does not need to be redesigned — ensure it continues to work with the changes in this document (token rotation on reconnect per §5.1, clock drift recalculation per §5.2, and sync trigger per §5.10).

### 5.8 CRUD Blocking During Sync

All client-side CRUD operations (get, getAll, upsert, delete) and query subscriptions MUST wait for any in-progress sync to complete before executing. The library maintains a sync promise: when sync is active the promise is pending and all CRUD hooks await it; when sync completes (or the connection is lost) the promise resolves and queued operations proceed immediately.

This ensures:

- **Reads return post-sync state.** A read that fires during sync would return stale pre-merge data; blocking guarantees the client sees the merged result.
- **Writes don't race with sync.** A write during sync could produce audit entries that conflict with the merge the server just performed; blocking prevents this.

If no sync is active, the promise is pre-resolved and operations proceed without delay. The blocking is transparent to the app — hooks simply await the promise before touching the database.

### 5.9 Collection Bootstrap and On-Demand Data

There is no dedicated "initial load" or "bootstrap" step. Collections are set up as empty tables after authentication (§4.5). The server does not proactively push records to a new client on connection — empty collections are perfectly valid.

**On-demand data via reactive subscriptions:** Data flows to the client through the existing hooks (e.g. `get`, `getAll`, query subscriptions). The subscription protocol (WebSocket message format, server-side subscription tracking, teardown on component unmount, and re-establishment on reconnect) is already implemented in the library and does not need to be redesigned — ensure it continues to work with the changes in this document. Each hook follows a two-phase pattern:

1. **Local-first:** The hook queries the local database immediately and returns whatever is there (which may be zero records if the collection is empty or the client is offline).
2. **Remote subscription:** Simultaneously, the hook establishes a subscription with the server for the same query. When the server responds with records, the client stores them locally and the hook re-fires the local query — updating the caller reactively with the new data.

The caller does not need to know whether data came from local cache or the server. The hook's returned data updates transparently as records arrive.

**Offline to online transition:** If the client is offline when the app requests data, the hook returns whatever is available locally (possibly empty). When the client reconnects, the remote subscription is re-established and the server sends the requested data. The client stores it locally and the hook re-fires, delivering the records to the app at the point where it originally requested them. The app does not need to re-request — the subscription stays live across connection changes.

**Sync on connection (returning device with pending changes):** When the client connects and has pending audit entries (besides branched) or dirty `_sync` records (for audit-free collections), it syncs them. The server merges (audited) or compares timestamps (audit-free), responds with per-id results, and populates the per-client record id set (§5.6). Push updates then deliver any subsequent changes from other clients as they happen.

**Client storage growth:** While the client is online, audit entries are synced promptly and collapsed to a single branch entry per record (§5.6 rule 3). This keeps audit storage minimal during normal operation. The live record data will grow as records accumulate; managing live data volume (e.g. pagination, eviction, archival) is a future concern and out of scope for this design.

### 5.10 Sync Trigger

The client initiates a sync whenever it **connects or reconnects** to the server. This is the sole automatic trigger:

1. **On connection** (first start or reconnect after being offline): The client syncs every collection, sending all record ids it has (plus pending audit entries for audited collections, or dirty records for audit-free collections). This serves two purposes: (a) it pushes any offline changes to the server, and (b) it populates the server's in-memory per-client record id set (§5.6) so the server knows which records this client has and can push updates to it going forward.
2. **After local changes:** When the user modifies a record while connected, the client syncs the affected collection promptly. For audited collections, the new audit entries are sent. For audit-free collections, the full record + `lastUpdatedAt` is sent. If already syncing, changes are preserved and synced in the next cycle.
3. **CRUD blocking (§5.8)** ensures that reads and writes wait for an in-progress sync to finish before executing.

The sync is per-collection (§5.7). Each collection syncs independently and can retry on failure without blocking others.

### 5.11 Sync Idempotency

Sync requests are **idempotent**. If the client sends the same audit entries twice (e.g. a network retry where the first request succeeded but the response was lost), the server handles it safely. Audit entries are identified by their ULID; duplicate entries are detected and handled per §6.9 row 8 (keep the last occurrence). The server's materialised state and per-client record id set converge to the same result regardless of whether the request is received once or multiple times.

## 6. Conflict Resolution & Client State Management

### 6.1 Concurrent Field Updates (Last Write Wins)

The higher ULID value wins.

### 6.2 Orphaned Operations (Nested Deletion)

Deletions of parent objects discard child updates to prevent "Partial Resurrection."

### 6.3 Record Copy Hook (useRecord / useState-like)

The app uses a hook that provides the user with a working copy of the master record to modify. It is more than a simple "rebase" — it is the primary way the app lets the user edit a synced record while preserving their edits when server updates arrive.

**API:** The hook returns `[record, setRecord]`, similar to `useState`. The app passes `oldState` (or equivalent) and an `onChange` callback (or similar, as `useState` provides).

**Behaviour when the server pushes an update:** The hook updates only those fields the user has *not* modified. To compute which fields to update:

1. `localDiff = diff(oldState, userState)` — the user's local changes.
2. `rebasedState = materialise(newState, localDiff)` — apply the server's `newState` but preserve `localDiff` (fields the user edited keep their values; unmodified fields get the server's values).
3. `oldState` becomes `newState` for the next comparison.

**Scope:** The hook handles updates from the server and provides a temporary copy of the record. It does not perform full rebase or sync logic beyond this merge.

**Applies to both audited and audit-free collections:** The rebase behaviour described above is the same regardless of whether the collection uses an audit trail. For audit-free collections, the underlying sync mechanism is full-record LWW (§4.5), but while the user is actively editing a record in the `useRecord` hook, the field-level diff/rebase still applies — the hook compares the user's local changes against the incoming server record and preserves the user's modified fields. The difference is only in how the final record is persisted: audited collections produce audit ops; audit-free collections write the full record directly and set `isDirty: true` on the `_sync` entry.

**Conflict resurrection prompt:** When the user is editing a record and the server signals that an ID-boxed item (or the record itself) is being deleted—i.e. it exists in `oldState` but not in `newState`—the hook flags a conflict and prompts the user whether to **Restore** it. This applies only in the editing context.

### 6.4 Root Record Deletion Conflict

This applies only when the user is editing a record (same context as §6.3).

1. **Flush First:** Client attempts a final sync of local audit.
2. **Notification:** The library uses the `onConflictResolution` mechanism (§6.4) to present a message (phrased as a yes/no question) and obtain the user's decision.
3. **Resurrection:** If the user returns `true`, the client sends a Type 3 (Restored) entry. If `false`, the record and audit are removed locally.

**Notification and decision mechanism:** The library uses `onConflictResolution` provided at the **MXDB core component** on the client. When a conflict occurs (§6.3 or §6.4), the library supplies a **message**; the app returns `true` or `false`. Messages MUST be phrased so that a yes/no answer maps to true/false respectively (e.g. "Restore this item?" → yes = true, no = false). The hook obtains the resolver from **context** and calls it with the message to request the async response: `const decision = await resolveConflict(message)`.

### 6.5 Error Surfacing

Errors that occur within the library (sync failures, authentication issues, collection errors, WebSocket disconnects, etc.) are surfaced to the app through two mechanisms:

**1. `onError` callback on the MXDB core component:**

```typescript
type MXDBErrorSeverity = 'warning' | 'error' | 'fatal';

interface MXDBError {
  code: MXDBErrorCode;
  message: string;
  severity: MXDBErrorSeverity;
  collection?: string;
  recordId?: string;
  originalError?: unknown;
}

// Provided as a prop on the MXDB provider component
onError?: (error: MXDBError) => void;
```

The app provides this callback when mounting the MXDB provider. The library calls it for all errors — from transient sync retries (`warning`) to permanent failures (`error`) to unrecoverable states like authentication rejection (`fatal`). The app can use this for logging, user notifications, or telemetry.

**2. Error state on hooks:**

Each data hook (e.g. `useGet` from `useCollection`) exposes an `error` field alongside its data:

```typescript
const { useGet } = useCollection(todosCollection);
const { record, isLoading, error } = useGet(id);
```

- `error` is `undefined` when no error has occurred.
- When a query fails (e.g. the collection does not exist locally, the database is not open, or a remote subscription fails), `error` is populated with an `MXDBError`.
- The error state is cleared on the next successful data retrieval.
- This allows the app to render error UI inline at the component level.

**Error codes** are string constants exported by the library. The full list with descriptions, severities, and triggering scenarios is in §7.6.

### 6.6 Audit Pruning and Deep Drift (Deferred)

Audit pruning (removing old audit entries to save storage) and the associated Deep Drift recovery flow (what happens when a client's anchor points to a purged entry) are **deferred** and not part of the current implementation. The audit trail is kept in full indefinitely on both server and client. If audit pruning is needed in the future, a separate design will cover the pruning strategy, retention policy, and client recovery mechanism.

### 6.7 Local-First Creation Collision

The first ULID to hit the server for a specific `recordId` "Created" entry wins.

### 6.8 Audit Replay / Merge Failure Policy (Server and Client)

When the auditor cannot apply an operation or cannot materialise a record, behaviour depends on the cause. The system MUST make a deterministic choice per scenario. **§6.9** lists every scenario in detail with a place to record the chosen behaviour for each.

---

### 6.9 Corruption and Replay Failure Scenarios (Decision List)

The following scenarios can occur during **replay** (materialising a record from audit history), **merge** (combining client and server audit), or **apply** (applying a single op to state). For each, record the chosen behaviour so implementation is consistent.


| #   | Scenario                              | Description / When it occurs                                                                                                                                                       | Where                                   | Decision                                                                                                                                                                                                                |
| --- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Missing parent path segment**       | The op’s path references a parent (e.g. `items.2.label`) but the parent doesn’t exist (e.g. `items` has length 1, or `items.2` is missing).                                        | Replay (server or client)               | Ignore op.                                                                                                                                                                                                              |
| 2   | **Hash-anchored mismatch**            | Op targets an index with a content hash; the index exists but the current content hash doesn’t match (array shifted or mutated).                                                   | Replay                                  | Ignore op.                                                                                                                                                                                                              |
| 3   | **Invalid boxed-id path**             | Path uses boxed id (e.g. `items.[id:abc]`) but no element in the array has that id.                                                                                                | Replay                                  | Ignore op.                                                                                                                                                                                                              |
| 4   | **Corrupt audit structure**           | Audit or history is malformed: not an array, entry missing required fields (`id`, `type`, `recordId`, `timestamp`), invalid ULID format, duplicate entry ids in history. | Sync request validation / before replay | Report corrupt audit entry to log with details of the record and audit; remove op from audit.                                                                                                                           |
| 5   | **Unreplayable op (throws)**          | A single op application throws (e.g. type error, internal invariant, or unknown exception from the auditor).                                                                       | Replay                                  | Report unplayable/erroneous audit entry to log with details of the record and audit; remove op from audit.                                                                                                              |
| 6   | **Schema / version mismatch**         | Record shape or op format does not match the current schema (e.g. new required field, changed enum).                                                                               | Replay or merge                         | Report outdated schema audit entry to log with details of the record and audit; remove op from audit.                                                                                                                   |
| 7   | **Merge fails**                       | Client and server audits cannot be merged (e.g. merge algorithm throws or returns invalid).                                                                                        | Server during sync                      | Report problematic audit entry to log with details of the record and audit; remove op from audit.                                                                                                                       |
| 8   | **Duplicate entry id in history**     | Two entries in the same audit history share the same ULID.                                                                                                                         | Replay / validation                     | Should never occur; if it does report in the log with details and remove the first op, keep the last op.                                                                                                                |
| 9   | **Out-of-order entries**              | History entries are not ordered by ULID / timestamp (e.g. sort order violated).                                                                                                    | Replay                                  | Re-sort the audit entries and retry.                                                                                                                                                                                    |
| 10  | **Created entry invalid**             | A `Created` entry has a missing, null, or invalid `record` payload.                                                                                                                | Replay                                  | Attempt to reverse engineer the original from the audit and current state. If possible add original state to created op. If not possible report to log with details and restart audit with current state as created op. |
| 11  | **Invalid path syntax**               | Op path is not parseable or uses an unknown format (e.g. bad boxed-id syntax).                                                                                                     | Replay                                  | Ignore op.                                                                                                                                                                                                              |
| 12  | **Op value violates schema**          | A `Replace` or `Add` op has a value that violates the record schema (e.g. wrong type).                                                                                             | Replay                                  | Ignore op.                                                                                                                                                                                                              |
| 13  | **Position unresolvable**             | `Add`/`Move` with `First`/`Last` cannot be applied (e.g. target array does not exist or is not an array).                                                                          | Replay                                  | Ignore op.                                                                                                                                                                                                              |
| 14  | **Transient server I/O failure**      | Write to live or audit collection fails due to a transient cause (network timeout, temporary unavailability, transaction conflict/abort).                                           | Server during sync write                | Retry with configurable delay (default 5 seconds) between attempts. Keep retrying — no limit.                                                                                                                           |
| 15  | **Permanent server I/O failure**      | Write fails due to a non-transient cause (document too large, schema validation error, constraint violation, disk full).                                                            | Server during sync write                | Do not retry. Log the error with full details (record id, audit, cause). Return an error to the client for this record id. The client preserves its audit and can retry later or surface the error to the user.          |
| 16  | **Client replay failure**             | Client fails to materialise from audit (e.g. after applying server push or local ops).                                                                                             | Client                                  | Apply the actions based on the cause, per the scenarios in this table. (Client replay of audit is rare.)                                                                                                                |
| 17  | **Unknown collection in sync request**| Client sends a sync request for a collection name the server does not recognise (not in the registered definitions).                                                               | Server during sync                      | Reject the request with a "not found" error for that collection. The client MUST delete the local collection and its data.                                                                                              |
| 18  | **Concurrent delete + create (same id)** | Client A deletes record X, Client B creates a record that is also id X. Both syncs arrive at the server.                                                                       | Server during merge                     | Extremely unlikely with ULID-generated ids (80 bits of randomness per ms). If it occurs: creation wins (less destructive). The merged audit contains a Deleted entry followed by a Restored entry, then an Updated entry to bring the record into the shape of the newly created record. |


**How to use this table:** Fill in the **Decision** column for each row (and add rows if you discover more scenarios). Then implement §6.9 so that the auditor and sync logic follow these decisions. §8.1.4 refers to implementing the chosen behaviour.

---

## 7. Public API

### 7.1 Package Exports and Conditional Resolution

The library is published as `@anupheaus/mxdb` with three sub-path exports and a **conditional root export** that resolves to either the server or client implementation based on the runtime target:

```json
{
  "exports": {
    ".": {
      "node": {
        "types": "./dist/server/index.d.ts",
        "import": "./dist/server.js",
        "require": "./dist/server.js"
      },
      "default": {
        "types": "./dist/client/index.d.ts",
        "import": "./dist/client.js",
        "require": "./dist/client.js"
      }
    },
    "./server": {
      "types": "./dist/server/index.d.ts",
      "import": "./dist/server.js",
      "require": "./dist/server.js"
    },
    "./client": {
      "types": "./dist/client/index.d.ts",
      "import": "./dist/client.js",
      "require": "./dist/client.js"
    },
    "./common": {
      "types": "./dist/common/index.d.ts",
      "import": "./dist/common.js",
      "require": "./dist/common.js"
    }
  }
}
```

**How it works:**

- **Node.js** (and bundlers with `target: 'node'`): `import { useCollection } from '@anupheaus/mxdb'` resolves to the **server** implementation via the `node` condition.
- **Browsers** (and bundlers with `target: 'web'`, e.g. webpack): the same import resolves to the **client** implementation via the `default` condition.
- **Explicit imports** are always available: `@anupheaus/mxdb/server`, `@anupheaus/mxdb/client`, `@anupheaus/mxdb/common`.

**TypeScript resolution:** TypeScript resolves types from the `types` field matching the active condition. For this to work, the consuming project must use `moduleResolution: "bundler"` (or `"node16"` / `"nodenext"`) in its `tsconfig.json`. If the consuming project has both server and client code in a single tsconfig, TypeScript can only resolve one set of types for the root import — in that case, the consumer should either use separate tsconfigs for server and client code, or use the explicit sub-path imports (`@anupheaus/mxdb/server`, `@anupheaus/mxdb/client`).

**Webpack alignment:** The existing webpack config already targets `node` for the server build and `web` for the client build (§1.1), so the conditional exports resolve correctly at both build time and runtime.

#### Recommended consuming project structure

Apps using this library should split their TypeScript configuration so that server and client code each have their own tsconfig. This ensures that `import { useCollection } from '@anupheaus/mxdb'` resolves to the correct types in each context — server code sees `MXDBServerCollection<T>`, client code sees `MXDBClientCollection<T>`.

```
my-app/
├── common/
│   ├── tsconfig.json              ← base config
│   └── collections.ts            ← defineCollection calls
├── server/
│   ├── tsconfig.json              ← extends ../common/tsconfig.json
│   └── index.ts                  ← server code
├── client/
│   ├── tsconfig.json              ← extends ../common/tsconfig.json
│   └── App.tsx                   ← React app
└── webpack.config.js
```

**`common/tsconfig.json`** — base config, shared compiler options:

```json
{
  "compilerOptions": {
    "strict": true,
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "target": "es2020",
    "lib": ["DOM", "ES2020"]
  }
}
```

**`server/tsconfig.json`** — adds the `node` condition so the root import resolves to the server API:

```json
{
  "extends": "../common/tsconfig.json",
  "compilerOptions": {
    "customConditions": ["node"]
  },
  "include": ["../common/**/*", "./**/*"]
}
```

**`client/tsconfig.json`** — no `customConditions` needed; TypeScript falls through to `default`, which resolves to the client API:

```json
{
  "extends": "../common/tsconfig.json",
  "include": ["../common/**/*", "./**/*"]
}
```

**How `defineCollection` in common works:** Collection definitions use the explicit sub-path `@anupheaus/mxdb/common`, which is **not** conditionally resolved — it always points to the same module and the same types regardless of which tsconfig is active. The `MXDBCollection<RecordType>` object returned by `defineCollection` is a plain data object carrying a phantom type parameter for inference. It contains no server or client logic. Both tsconfigs include the `common/` folder in their `include` paths, so the same collection definition files are visible to both.

When the collection object is later passed to `useCollection`, the return type is determined by **which `useCollection` was imported** — the server or client version — not by the collection definition itself:

```typescript
// common/collections.ts — identical under both tsconfigs
import { defineCollection } from '@anupheaus/mxdb/common';
export const todosCollection = defineCollection<TodoRecord>({ name: 'todos', indexes: [] });

// server/index.ts — tsconfig has customConditions: ["node"]
import { useCollection } from '@anupheaus/mxdb';     // → server types
import { todosCollection } from '../common/collections';
const { get } = useCollection(todosCollection);
const record = await get('id');  // ✓ Promise<TodoRecord | undefined>

// client/App.tsx — tsconfig has no customConditions (default)
import { useCollection } from '@anupheaus/mxdb';     // → client types
import { todosCollection } from '../common/collections';
const { useGet, upsert } = useCollection(todosCollection);
const { record, isLoading } = useGet('id');  // ✓ { record, isLoading, error }
```

This separation also benefits bundling: webpack's server build (with `target: 'node'`) and client build (with `target: 'web'`) resolve the conditional exports independently, matching the tsconfig type resolution.

### 7.2 Common Exports (`@anupheaus/mxdb/common`)

These are shared between server and client. Collection definitions live here so that the same objects can be imported by both sides.

```typescript
import { defineCollection } from '@anupheaus/mxdb/common';

const todosCollection = defineCollection<TodoRecord>({
  name: 'todos',
  indexes: [
    { name: 'by_userId', fields: ['userId'] },
    { name: 'by_status', fields: ['status'], isSparse: true },
    { name: 'by_city', fields: ['address.city'] },
  ],
  syncMode: 'Synchronised',
});
```

**Exported types:**

```typescript
type NestedKeyOf<T> =
  T extends object
    ? { [K in keyof T & string]: K | `${K}.${NestedKeyOf<T[K]>}` }[keyof T & string]
    : never;

type MXDBSyncMode = 'Synchronised' | 'ServerOnly' | 'ClientOnly';

interface MXDBCollectionIndex<RecordType extends Record = Record> {
  name: string;
  fields: NestedKeyOf<RecordType>[];
  isUnique?: boolean;
  isSparse?: boolean;
}

interface MXDBCollectionConfig<RecordType extends Record = any> {
  name: string;
  indexes: MXDBCollectionIndex<RecordType>[];
  syncMode?: MXDBSyncMode;     // default: 'Synchronised'
  disableAudit?: boolean;       // default: false
}

interface MXDBCollection<RecordType extends Record = any> {
  name: string;
  type: RecordType;             // phantom type for inference
}

function defineCollection<RecordType extends Record>(
  config: MXDBCollectionConfig<RecordType>
): MXDBCollection<RecordType>;
```

**Query and result types:**

```typescript
interface QueryProps<RecordType extends Record> {
  filters?: DataFilters<RecordType>;
  sorts?: DataSorts<RecordType>;
  offset?: number;
  limit?: number;
}

interface QueryResults<RecordType extends Record> {
  records: RecordType[];
  total: number;
}
```

### 7.3 Unified Collection API

Both server and client expose `useCollection`. The **imperative methods** share the same signatures and return types so that business logic (e.g. validation, transformation) can be written once and used on either side:

```typescript
interface MXDBCollectionOperations<RecordType extends Record> {
  get(id: string): Promise<RecordType | undefined>;
  get(ids: string[]): Promise<RecordType[]>;
  getAll(): Promise<RecordType[]>;
  upsert(record: RecordType): Promise<void>;
  upsert(records: RecordType[]): Promise<void>;
  remove(id: string): Promise<void>;
  remove(ids: string[]): Promise<void>;
  query(props?: QueryProps<RecordType>): Promise<QueryResults<RecordType>>;
  find(filters: DataFilters<RecordType>): Promise<RecordType | undefined>;
  distinct<K extends keyof RecordType>(
    field: K,
    props?: { filters?: DataFilters<RecordType> }
  ): Promise<RecordType[K][]>;
  onChange(callback: (event: MXDBCollectionChangeEvent<RecordType>) => void): Unsubscribe;
}
```

**`onChange` semantics:** The `onChange` callback fires on both local writes and remote updates (server pushes). On the server, it fires from MongoDB Change Streams. The event/callback mechanism is already implemented in the library — ensure it continues to work with the changes in this document.

`MXDBCollectionChangeEvent<RecordType>`:

```typescript
type MXDBCollectionChangeEvent<RecordType extends Record> =
  | { type: 'upsert'; records: RecordType[] }
  | { type: 'remove'; recordIds: string[] };
```

### 7.4 Server API (`@anupheaus/mxdb/server`)

#### Bootstrap

```typescript
interface MXDBServerConfig {
  collections: MXDBCollection[];
  mongoDbUrl: string;
  mongoDbName: string;
  logger?: Logger;
  onGetUserDetails(userId: string): Promise<unknown>;
  changeStreamDebounceMs?: number;       // default: 20
  tokenGracePeriodMs?: number;           // default: 60000
  inviteTtlMs?: number;                  // default: 300000
  rateLimitMaxAttempts?: number;         // default: 5
  rateLimitWindowMs?: number;            // default: 900000 (15 min)
  // ... socket server config (host, port, actions, subscriptions, etc.)
}

async function startServer(config: MXDBServerConfig): Promise<void>;
```

#### `useCollection` (server)

Called inside request handlers, actions, or lifecycle hooks (within the database context that `startServer` provides):

```typescript
function useCollection<RecordType extends Record>(
  collection: MXDBCollection<RecordType>
): MXDBServerCollection<RecordType>;

interface MXDBServerCollection<RecordType extends Record>
  extends MXDBCollectionOperations<RecordType> {
  clear(): Promise<void>;
  getRecordCount(): Promise<number>;
}
```

Server `useCollection` is **not** a React hook — it reads from Node.js async context (via `AsyncLocalStorage`). It can be called in any async scope that runs within the server's database provider.

**Note on `find`:** The unified API uses `DataFilters<RecordType>` (the library's own filter abstraction, same as `query`). The current server implementation uses MongoDB's native `Filter<>` for `find` — this should be aligned to use `DataFilters` for consistency. The server-side `DataFilters → MongoDB query` translator already exists in the library (used by `query`) and supports the same operator set as the client-side `DataFilters → SQL` translator (§4.3). Ensure the `find` method uses this existing translator rather than accepting raw MongoDB filters.

#### Invitation and device management

```typescript
async function createInviteLink(userId: string, domain: string): Promise<string>;
```

Creates an invitation link for the given user (§4.4). Generates a `requestId` (ULID), stores it in `mxdb_authentication` with the `userId`, and returns the full URL (e.g. `https://{domain}/invite/{requestId}`). The `domain` is provided by the caller at invocation time (e.g. `'app.example.com'`) rather than from server config, so the same server can generate invite links for different domains if needed. The returned link is for the app to distribute (email, WhatsApp, etc.).

```typescript
interface MXDBDeviceInfo {
  requestId: string;
  deviceDetails?: unknown;
  isEnabled: boolean;
  createdAt: number;
  lastConnectedAt?: number;
}

async function getDevices(userId: string): Promise<MXDBDeviceInfo[]>;
async function enableDevice(requestId: string): Promise<void>;
async function disableDevice(requestId: string): Promise<void>;
```

- `getDevices` — returns all devices (authenticated or pending) for a user, including their enabled/disabled status and device details.
- `enableDevice` / `disableDevice` — sets `isEnabled` on the `mxdb_authentication` record. A disabled device's token is rejected on the next connection attempt. The device can be re-enabled by the admin without requiring a new invite.

#### Collection lifecycle hooks

```typescript
function extendCollection<RecordType extends Record>(
  collection: MXDBCollection<RecordType>,
  hooks: {
    onBeforeUpsert?(payload: { records: RecordType[]; insertedIds: string[]; updatedIds: string[] }): Promise<void> | void;
    onAfterUpsert?(payload: { records: RecordType[]; insertedIds: string[]; updatedIds: string[] }): Promise<void> | void;
    onBeforeDelete?(payload: { recordIds: string[] }): Promise<void> | void;
    onAfterDelete?(payload: { recordIds: string[] }): Promise<void> | void;
    onBeforeClear?(payload: { collectionName: string }): Promise<void> | void;
    onAfterClear?(payload: { collectionName: string }): Promise<void> | void;
  }
): void;
```

#### Server usage example

```typescript
import { startServer, useCollection, extendCollection } from '@anupheaus/mxdb/server';
import { todosCollection } from '../common/collections';

extendCollection(todosCollection, {
  async onBeforeUpsert({ records }) {
    records.forEach(r => { r.updatedAt = Date.now(); });
  },
});

await startServer({
  collections: [todosCollection],
  mongoDbUrl: 'mongodb://localhost:27017',
  mongoDbName: 'myapp',
  async onGetUserDetails(userId) { /* ... */ },
  async onClientConnected({ socket }) {
    const { get, query } = useCollection(todosCollection);
    const record = await get('some-id');
  },
});
```

### 7.5 Client API (`@anupheaus/mxdb/client`)

#### Provider component

```typescript
interface MXDBSyncProps {
  host?: string;
  name: string;
  collections: MXDBCollection[];
  logger?: Logger;
  onError?(error: MXDBError): void;                    // §6.5
  onConflictResolution?(message: string): Promise<boolean>;  // §6.4
  onSaveUserDetails?(userDetails: unknown): Promise<void>;
  onRegisterInvitePattern?(pattern: string): void;
  children?: ReactNode;
}

function MXDBSync(props: MXDBSyncProps): JSX.Element;
```

#### Invite link handling

The library handles the full invite flow on the client, including intercepting invite URLs. On web, the `<MXDBSync>` provider registers a handler that inspects the current URL on mount (and listens for subsequent navigation events via the `popstate` event) for invite patterns (e.g. `/invite/{requestId}` or `?invite={requestId}`). On Cordova, the app installs a deep-link plugin (e.g. `cordova-plugin-deeplinks`) that fires an event when a Universal Link / App Link is opened; the library listens for these events via the standard `universalLinks.subscribe()` API.

When an invite URL is detected, the library automatically:

1. Extracts the `requestId` from the URL.
2. Initiates WebAuthn registration (`credentials.create()` with PRF) to create a new credential on this device.
3. Sends the `requestId` and device details to the server.
4. Receives the authentication token and user details in the response.
5. Creates the encrypted database (keyed by the WebAuthn PRF-derived key).
6. Stores the token internally and invokes `onSaveUserDetails` so the app can persist the user record.
7. Establishes the WebSocket connection and begins normal operation.

The invite URL pattern is defined internally by the library (matching the pattern used by `createInviteLink` on the server). The app is responsible for registering this pattern with the platform (e.g. adding a route in React Router, configuring Universal Links on Cordova). To facilitate this, the `<MXDBSync>` provider accepts an `onRegisterInvitePattern` callback:

```typescript
// Props on MXDBSync provider
interface MXDBSyncProps {
  // ... existing props ...
  onRegisterInvitePattern?(pattern: string): void;
}
```

The library calls `onRegisterInvitePattern` on mount, passing the URL path pattern (e.g. `"/invite/:requestId"`). The app uses this to register the route or deep link handler as appropriate for its platform. When the registered route is triggered, the app passes the URL to the library via `useMXDBInvite().handleInviteUrl(url)`.

The library provides a hook for the app to observe and trigger the invite flow:

```typescript
function useMXDBInvite(): {
  readonly isProcessing: boolean;
  readonly error: MXDBError | undefined;
  handleInviteUrl(url: string): Promise<void>;
};
```

- `isProcessing` — `true` while the invite flow is running (for loading UI).
- `error` — populated if the invite fails (expired link, rate-limited, server error, etc.).
- `handleInviteUrl(url)` — allows the app to manually trigger the invite flow with a URL, e.g. when receiving a Cordova deep link event that the library doesn't intercept automatically.

#### `useCollection` (client)

Called inside React function components that are descendants of `<MXDBSync>`:

```typescript
function useCollection<RecordType extends Record>(
  collection: MXDBCollection<RecordType>
): MXDBClientCollection<RecordType>;

interface MXDBClientCollection<RecordType extends Record>
  extends MXDBCollectionOperations<RecordType> {
  // React hooks (must follow Rules of Hooks)
  useGet(id: string | undefined): {
    record: RecordType | undefined;
    isLoading: boolean;
    error: MXDBError | undefined;
  };
  useQuery(props?: QueryProps<RecordType> & { disable?: boolean }): {
    records: RecordType[];
    total: number;
    isLoading: boolean;
    error: MXDBError | undefined;
  };
  useDistinct<K extends keyof RecordType>(field: K): {
    values: RecordType[K][];
    isLoading: boolean;
    error: MXDBError | undefined;
  };
}
```

Client `useCollection` IS a React hook — it reads from React context. The returned object contains both **imperative async methods** (identical signatures to the server) for use in event handlers, effects, and callbacks, and **React hooks** for declarative data binding in render.

#### `useRecord`

A convenience hook for working with a single record — combines fetching, loading state, and mutation methods:

```typescript
function useRecord<RecordType extends Record>(
  recordOrId: RecordType | string | undefined,
  collection: MXDBCollection<RecordType>
): {
  record: RecordType | undefined;
  isLoading: boolean;
  error: MXDBError | undefined;
  upsert(record: RecordType): Promise<void>;
  remove(): Promise<void>;
};
```

#### `useMXDBSync`

Exposes the sync and connection state for UI indicators:

```typescript
function useMXDBSync(): {
  readonly isSynchronising: boolean;
  readonly isConnected: boolean;
  onConnectionStateChanged(callback: (isConnected: boolean) => void): void;
  onSyncChanged(callback: (isSyncing: boolean) => void): void;
};
```

#### Client usage example

```typescript
import { MXDBSync, useCollection, useRecord, useMXDBSync } from '@anupheaus/mxdb/client';
import { todosCollection } from '../common/collections';

// App root
function App() {
  return (
    <MXDBSync
      name="myapp"
      collections={[todosCollection]}
      onError={err => console.error(err)}
    >
      <TodoList />
    </MXDBSync>
  );
}

// Component using imperative + hook APIs
function TodoList() {
  const { useQuery, upsert } = useCollection(todosCollection);
  const { records, isLoading, error } = useQuery({ sorts: { createdAt: 'desc' } });
  const { isConnected } = useMXDBSync();

  const handleAdd = async () => {
    await upsert({ id: ulid(), title: 'New todo', done: false });
  };

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBanner error={error} />;
  return <>{records.map(r => <TodoItem key={r.id} id={r.id} />)}</>;
}

// Component using useRecord
function TodoItem({ id }: { id: string }) {
  const { record, isLoading, upsert, remove } = useRecord(id, todosCollection);
  if (isLoading || !record) return <Skeleton />;
  return (
    <div>
      <span>{record.title}</span>
      <button onClick={() => upsert({ ...record, done: !record.done })}>Toggle</button>
      <button onClick={remove}>Delete</button>
    </div>
  );
}
```

### 7.6 Error Types

Shared between server and client (exported from common):

```typescript
type MXDBErrorSeverity = 'warning' | 'error' | 'fatal';

interface MXDBError {
  code: MXDBErrorCode;
  message: string;
  severity: MXDBErrorSeverity;
  collection?: string;
  recordId?: string;
  originalError?: unknown;
}
```

**Error codes:**

| Code | Severity | Description | Triggered by |
|------|----------|-------------|--------------|
| `SYNC_FAILED` | `warning` / `error` | Sync for a collection failed (transient on first retries, escalated after exhausting retries). | §5.7 retry exhaustion, §6.9 rows 14–15 |
| `AUTH_REJECTED` | `fatal` | Authentication token is invalid, expired, or belongs to a disabled device. | §5.1 step 6, §4.4 disabled device |
| `COLLECTION_NOT_FOUND` | `error` | Server does not recognise the collection name in a sync request. | §6.9 row 17 |
| `DB_NOT_OPEN` | `fatal` | Operation attempted but the encrypted database is not open (user not authenticated). | §4.3 decision logic, §8.3.1 |
| `TIMEOUT` | `warning` | A sync request or subscription timed out (will be retried). | §5.7, §8.2.2 |
| `TOKEN_ROTATION_FAILED` | `error` | Client failed to store the new token or the ack was not received by the server. | §4.4 token rotation |
| `WRONG_SIDE_COLLECTION` | `fatal` | `useCollection` called with a collection whose `syncMode` doesn't apply to the current side. | §4.5 wrong-side access |
| `INVITE_EXPIRED` | `error` | The invite link's `requestId` ULID timestamp is past the configured TTL. | §4.4 TTL validation |
| `INVITE_ALREADY_USED` | `error` | The `requestId` has already been consumed (successful or failed). | §4.4 single-use |
| `INVITE_DISABLED` | `error` | The `requestId` was previously used and failed authentication; the record is disabled. | §4.4 single-use |
| `RATE_LIMITED` | `warning` | Too many failed invite attempts from this IP; request rejected. | §4.4 rate limiting |
| `DEVICE_DISABLED` | `fatal` | The device has been disabled by the admin; connection rejected. | §4.4 device revocation, §5.1 step 6 |
| `REPLAY_FAILED` | `error` | Audit replay or merge failed for a specific record (corrupt/invalid entries). | §6.8, §6.9 rows 4–7, 10 |
| `IO_PERMANENT` | `error` | A non-transient server I/O failure (document too large, disk full, constraint violation). | §6.9 row 15 |
| `SUBSCRIPTION_FAILED` | `warning` | A remote data subscription could not be established or was dropped. | §5.9 subscription failure |
| `UNKNOWN` | `error` | An unexpected error not covered by the above codes. | Catch-all |

```typescript
type MXDBErrorCode =
  | 'SYNC_FAILED'
  | 'AUTH_REJECTED'
  | 'COLLECTION_NOT_FOUND'
  | 'DB_NOT_OPEN'
  | 'TIMEOUT'
  | 'TOKEN_ROTATION_FAILED'
  | 'WRONG_SIDE_COLLECTION'
  | 'INVITE_EXPIRED'
  | 'INVITE_ALREADY_USED'
  | 'INVITE_DISABLED'
  | 'RATE_LIMITED'
  | 'DEVICE_DISABLED'
  | 'REPLAY_FAILED'
  | 'IO_PERMANENT'
  | 'SUBSCRIPTION_FAILED'
  | 'UNKNOWN';
```

### 7.7 API Alignment Summary

| Operation | Server | Client (imperative) | Client (hook) |
|-----------|--------|---------------------|---------------|
| `get(id)` | `Promise<T \| undefined>` | `Promise<T \| undefined>` | `useGet(id) → { record, isLoading, error }` |
| `get(ids)` | `Promise<T[]>` | `Promise<T[]>` | — |
| `getAll()` | `Promise<T[]>` | `Promise<T[]>` | `useGetAll(props?) → { records, isLoading, error }` |
| `upsert(record)` | `Promise<void>` | `Promise<void>` | — |
| `remove(id)` | `Promise<void>` | `Promise<void>` | — |
| `query(props)` | `Promise<QueryResults<T>>` | `Promise<QueryResults<T>>` | `useQuery(props) → { records, total, isLoading, error }` |
| `find(filters)` | `Promise<T \| undefined>` | `Promise<T \| undefined>` | — |
| `distinct(field)` | `Promise<T[K][]>` | `Promise<T[K][]>` | `useDistinct(field) → { values, isLoading, error }` |
| `onChange(cb)` | `Unsubscribe` | `Unsubscribe` | — |
| `clear()` | `Promise<void>` | — | — |
| `getRecordCount()` | `Promise<number>` | — | — |

**Design decision:** The imperative methods (get, getAll, upsert, remove, query, find, distinct, onChange) share identical signatures on both sides. The client adds React hooks (useGet, useGetAll, useQuery, useDistinct) for declarative rendering. The server adds administrative methods (clear, getRecordCount) that are not exposed to the client.

**Note on `remove`:** The current client implementation returns `Promise<boolean>`. This should be aligned to `Promise<void>` to match the server. Remove is idempotent — removing a non-existent record is not an error; it is a no-op.

## 8. Implementation Follow-ups (from Current Code to This Spec)

This section tracks concrete follow-ups required to bring the current library in line with this document. Items may reference the section where the desired behaviour is specified.

### 8.1 Server

1. **Write atomicity (transactions):** Implement §4.2 requirement: live + audit writes for sync MUST be transactional.
2. **Sync response with records:** Implement §5.5 response contract — include materialised records in the sync response where hashes differ, and update the per-client record id set (§5.6).
3. **Server push with per-client record id tracking:** Implement §5.6: maintain `Map<clientId, Set<recordId>>` in memory. Push updates to all clients that have the record id. For audited collections, include `auditEntryId` in the push payload. For audit-free collections, push the record only.
4. **Audit replay failure decisions:** Implement §6.9 policy and ensure the server returns deterministic outcomes.
5. **Token rotation:** Implement §4.4 token rotation — generate a new ULID token on each connection and return it to the client.
6. **Invite link security:** Implement §4.4 single-use requestIds, rate limiting on invite redemption.
7. **API alignment:** Align server `useCollection` return shape with §7.3 unified interface. Ensure `remove` returns `Promise<void>` (not relying on MongoDB result). Align `find` to use `DataFilters<RecordType>` instead of MongoDB `Filter<>` per §7.3.
8. **Invitation API:** Implement `createInviteLink(userId, domain)` per §7.4.
9. **Device management API:** Implement `getDevices(userId)`, `enableDevice(requestId)`, `disableDevice(requestId)` per §7.4.

### 8.2 Client

1. **Post-sync anchor reset and hash verification:** After a successful sync:
  - **Client:** Takes the ULID from the last audit entry, clears the audit, and adds a new branched audit entry with that ULID.
  - **Sync payload:** Each `AuditOf` in the sync request carries a `hash` of the client's materialised record state (see §2.2). The server compares this to the end result of its own audit replay.
  - **Hash mismatch:** If the server's materialised result does not match the client's hash, the server includes the corrected record and its latest branch ULID in the sync response (§5.5).
  - **Client applies correction:** When the client receives a record + auditEntryId (e.g. due to hash mismatch), it checks its local audit. If the audit consists only of a branched entry, the client replaces the record and updates the branch entry with the server's ULID. It is possible that the ULID is the same but the record is different - this is fine, replace the record.  If the client has pending local history, it ignores the correction completely and instead sends its audit to the server to merge.
2. **Sync failure and timeout:** When a sync fails (network or timeout), the audit history is preserved in full. When network connectivity is restored or connections to the server are accepted, the client checks whether it has any audit entries (besides branched); if it does, it syncs them. See §8.2.1 for the next steps after sync.
3. **Disconnect during sync:** If the socket disconnects while sync is pending, audit history is not changed. The implementation releases waiters and marks sync as not busy. The client then waits for reconnection as in §8.2.2 and continues as §8.2.2 (checks for audit entries besides branched, syncs them; see §8.2.1 for next steps).
4. **Collection bootstrap:** Per §5.9, collections start empty after authentication. The server does not push data proactively — the client requests records on demand through hooks. No dedicated bootstrap API is needed.
5. **Rebase hook and conflict resurrection (§6.3–6.4):** The doc describes the rebase formula and the steps at a high level. When the server signals that a record should be deleted, the client follows §6.3 and §6.4.
6. **Client-side record deletion and audit lifecycle:** When a record is deleted on the client side, a deleted entry is added to the audit and the live record is deleted. The audit is sync'd with the server; if successful, the audit can then be deleted. If not, it remains on the client side until successfully sync'd.
7. **Collection isolation and retries:** Per §5.7, the client initiates and retries collection syncs. One collection failing must not block others; retry a few times, then surface the error to the user.
8. **Client storage (SQLite + OPFS + encryption at rest):** SQLite on OPFS via `@sqlite.org/sqlite-wasm` per §4.3, with application-layer AES-GCM on the persisted file when a derived key is present. All reads and writes run in a worker (dedicated or shared per §4.9). Live records are stored as JSON blobs per §4.3; expression indexes are created from `MXDBCollectionConfig.indexes`. The `_audit` and `_sync` tables use explicit SQLite columns (not JSON blobs) per §4.3.
9. **DataFilters → SQL transformer:** Implement the bespoke `DataFilters → SQL WHERE clause` translator per §4.3, replacing the `sift` dependency. Register a custom `REGEXP` function on the SQLite connection for `$regex` support. Ensure generated `json_extract` expressions match the expression index definitions exactly so SQLite uses them.
10. **CRUD blocking during sync:** Per §5.8, the existing `finishSyncing()` promise mechanism already gates all CRUD hooks and subscription queries. Verify this continues to work after the storage migration and that the sync promise lifecycle (pending during sync, resolved on completion or disconnect) is preserved.
11. **Token rotation on connect:** Per §4.4, when the server returns a new token on connection, the client MUST store it in the encrypted database immediately, replacing the old token.
12. **Multi-tab coordination:** Implement §4.9 SharedWorker (or Web Locks fallback) so that multiple tabs share a single database connection and sync lifecycle.
13. **Sign-out flow:** Implement §4.8 sign-out: close the encrypted database, clear in-memory state. The database file remains on disk for future sign-in.
14. **Unknown collection handling:** Per §6.9 row 17, if the server rejects a sync request with a "not found" error for a collection, the client MUST delete the local collection and its data.
15. **API alignment:** Align client `useCollection` return shape with §7.3 unified interface. Change `remove` to return `Promise<void>`. Ensure `useGet`, `useGetAll`, `useQuery`, `useDistinct` expose `error` field per §7.5.
16. **Error surfacing:** Implement `onError` callback on `MXDBSync` provider and `error` field on all hooks per §6.5.
17. **Invite link handling:** Implement the invite URL interception and `useMXDBInvite` hook per §7.5. On web, inspect `window.location` on mount and listen for `popstate`. On Cordova, listen for `universalLinks.subscribe()` events.
18. **Audit-free sync (`_sync` collection):** Implement the `_sync` table alongside the live table for collections with `disableAudit: true` per §4.5. Track `isDirty`, `lastUpdatedAt`, and `isDeleted` flags. Send dirty records with full payloads on sync; handle ack/correction responses; compare locally on push receipt.

### 8.3 Cross-cutting

1. **UserId / auth:** The current userId is derived from the authentication token on the server (§5.1). Requests for data or to change data must not be accepted until a valid token is provided. If an operation is attempted without authentication, this library MUST raise an Unauthorised Error. No unauthorised records should be written from the client — ever. If no user is logged in, no record should be written. Audit entries do not carry `userId` — each database is per-user and encrypted; only the authenticated user can access it, so the user is implicit.
2. **Hash-anchored op failure:** When an op uses hash anchoring and the hash does not match (e.g. index shifted and content changed), the design says "Silently Dropped" for missing parent path. When the index exists but the hash does not match, ignore the op.
3. **Schema / versioning:** The `AuditOf` model has a numeric `version` field (§2.2) for audit structure versioning. Shape of record is allowed to change — we ignore that; the ops should cover that situation. Audit ops changing will be covered by the version on the AuditOf model. **Collection-level versioning and migration** (e.g. what happens when the app bumps a collection's schema, migration callbacks, etc.) is deferred as a future enhancement — it is not part of the current implementation. `MXDBCollectionConfig` does not include a `version` field at this time.
4. **Transport security:** All client-server communication MUST use secure WebSockets (WSS) per §4.7. The library MUST refuse to connect over plain WS.
5. **Package exports:** Update `package.json` to add the conditional root export (`.` with `node`/`default` conditions) per §7.1. Ensure `typesVersions` covers the root path for older TypeScript module resolution.
6. **API alignment:** Ensure both sides export `useCollection` with return types matching §7.3–7.5. Extract `MXDBCollectionOperations<T>` as a shared interface in common.
7. **Error types:** Export `MXDBError`, `MXDBErrorCode` (all 16 codes per §7.6 table), `MXDBErrorSeverity` from common per §7.6.
8. **Wrong-side collection guard:** Both server and client `useCollection` MUST throw if the collection's `syncMode` doesn't apply to the current side (§4.5).
9. **Future optimisation — on-connection sync efficiency:** When a client connects with many collections and most records are unchanged, the current design sends all record ids per collection. A future optimisation could allow the client to send a **summary hash per collection** (hash of all record ids + a checksum) during the handshake; the server compares it to its own summary and skips collections that already match, reducing bandwidth and server processing for idle collections. This is not required for the initial implementation.
10. **Future enhancement — collection versioning and migration:** Add a `version` field to `MXDBCollectionConfig` along with a migration callback (e.g. `onMigrate(fromVersion, toVersion, db)`) so apps can transform data when a collection schema changes. Define what happens on version bump (run migration, update stored version). Not part of the current implementation.

