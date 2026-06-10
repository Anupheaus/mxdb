# Documentation Audit 2 Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document all new code added since the previous audit: two new subsystems (`src/client/remote-assistance/`, `src/server/mcp/`) plus scattered new files in `src/client/auth/`, `src/server/auth/`, `src/common/`, and `README.md`.

**Architecture:** Pure documentation — no production code changes. All tasks are independent.

**Tech Stack:** Markdown (AGENTS.md), README.md

---

## Task 1: Create `src/client/remote-assistance/AGENTS.md`

**Files:**
- Create: `src/client/remote-assistance/AGENTS.md`

**Background:** This directory implements client-side remote SQL assistance for MCP tooling. When the server's MCP endpoint receives a `mxdb_client_sqlite_query` tool call, it sends a `mxdbAdminClientSqlQueryAction` socket action to the target client. The client receives it, classifies the SQL as read-only or mutating, optionally prompts the user for consent on mutating queries, and executes it against the local SQLite `Db`. Results are returned to the server.

Files:
- `models.ts` — `MXDBRemoteAssistanceConfig` (config shape, has optional `onRemoteMutatingSqlRequested` callback) and `RemoteSqlMutatingRequestInfo` (`requestedBy: 'mcp'`, `operator: string`)
- `RemoteAssistanceContext.tsx` — `RemoteAssistanceContext` (React context holding `MXDBRemoteAssistanceConfig | undefined`) and `useRemoteAssistanceConfig()` hook
- `consentGate.ts` — `createMutatingConsentGate()` — returns an ask-once async gate; first call invokes the callback (or denies if none provided), subsequent calls return the memoized decision without re-prompting
- `sqlClassifier.ts` — `classifyClientSql(sql)` — conservative best-effort classifier; only SELECT and WITH (plus EXPLAIN SELECT/WITH) are read-only, everything else is mutating
- `remoteSqliteHandler.ts` — `handleRemoteSqliteQuery(db, request, ensureMutatingAllowed)` — routes to `db.execRaw` (mutating) or `db.queryRaw` (read-only); returns `MXDBRemoteSqliteQueryResponse`

- [ ] **Step 1: Write the AGENTS.md file**

Create `src/client/remote-assistance/AGENTS.md` with this exact content:

```markdown
# Remote assistance (`src/client/remote-assistance/`)

Client-side handler for MCP-initiated remote SQL queries against the local SQLite database.

## Overview

When the server's MCP endpoint receives a `mxdb_client_sqlite_query` tool call, it sends a
`mxdbAdminClientSqlQueryAction` socket action to the target client. This directory handles
the client-side half of that flow: classifying the SQL, optionally gating mutating writes
behind a user consent prompt, and executing the query against the local `Db`.

This feature is entirely opt-in from the host application's perspective — mount
`<RemoteAssistanceContext.Provider value={config}>` around the `MXDBSync` tree to enable it.
Without a context value, mutating queries are denied by default.

## Contents

### Config and context
- `models.ts` — `MXDBRemoteAssistanceConfig` (config shape: optional `onRemoteMutatingSqlRequested` callback) and `RemoteSqlMutatingRequestInfo` (`requestedBy: 'mcp'`, `operator: string`)
- `RemoteAssistanceContext.tsx` — `RemoteAssistanceContext` (React context carrying `MXDBRemoteAssistanceConfig | undefined`) and `useRemoteAssistanceConfig()` context hook

### SQL execution
- `remoteSqliteHandler.ts` — `handleRemoteSqliteQuery(db, request, ensureMutatingAllowed)` — classifies the SQL, checks consent for mutating queries, executes via `db.execRaw` or `db.queryRaw`, and returns `MXDBRemoteSqliteQueryResponse`
- `sqlClassifier.ts` — `classifyClientSql(sql)` — conservative best-effort classifier; only `SELECT` and `WITH` (and `EXPLAIN SELECT`/`EXPLAIN WITH`) are read-only; everything else is mutating

### Consent gate
- `consentGate.ts` — `createMutatingConsentGate(onRequest?)` — creates an ask-once in-memory gate; the first call invokes `onRequest` (or denies if `undefined`); all subsequent calls return the memoized decision without re-prompting

## Architecture

Flow for an incoming `mxdbAdminClientSqlQueryAction`:
1. `remoteSqliteHandler` calls `classifyClientSql` to determine if the SQL is mutating.
2. Read-only SQL is executed immediately via `db.queryRaw`.
3. Mutating SQL is passed to `ensureMutatingAllowed` (backed by `createMutatingConsentGate`).
   - If the host app provided `onRemoteMutatingSqlRequested`, the gate calls it once.
   - If no callback was provided or the callback returns `false`, the query is rejected with `MXDB_REMOTE_MUTATING_SQL_NOT_ALLOWED`.
4. Approved mutating SQL is executed via `db.execRaw` (returns no rows).

## Ambiguities and gotchas

- **Ask-once semantics:** `createMutatingConsentGate` memoizes the first decision for the lifetime of the gate instance. A fresh gate is created per socket action invocation — not per `MXDBSync` mount. If you need per-query consent, the callback must implement its own prompting logic (the gate itself won't re-ask).
- **`classifyClientSql` is conservative by design.** Any SQL that is not clearly `SELECT` or `WITH` is treated as mutating — including `PRAGMA`, `VACUUM`, and `EXPLAIN UPDATE`. When in doubt, consent is required.
- **`remoteSqliteHandler` does not throw.** All errors are returned as `{ error: { message: '...' } }` in the response, not thrown. The caller (`MXDBSyncInner`) handles the socket action lifecycle.

## Related

- [`../../../common/mcpActions.ts`](../../../common/mcpActions.ts) — `mxdbAdminClientSqlQueryAction` socket action descriptor (S2C)
- [`../../../common/mcpModels.ts`](../../../common/mcpModels.ts) — `MXDBRemoteSqliteQueryRequest` / `MXDBRemoteSqliteQueryResponse`
- [`../../../server/mcp/AGENTS.md`](../../../server/mcp/AGENTS.md) — server-side MCP endpoint that initiates these queries
- [`../providers/dbs/AGENTS.md`](../providers/dbs/AGENTS.md) — `Db` whose `queryRaw` / `execRaw` are called here
```

- [ ] **Step 2: Commit**

```
git add src/client/remote-assistance/AGENTS.md
git commit -m "docs: add AGENTS.md for client/remote-assistance"
```

---

## Task 2: Create `src/server/mcp/AGENTS.md`

**Files:**
- Create: `src/server/mcp/AGENTS.md`

**Background:** This directory implements the server-side MCP (Model Context Protocol) endpoint, exposing two JSON-RPC tools to AI assistants:
- `mxdb_clients_list` — returns all connected socket IDs with auth metadata
- `mxdb_client_sqlite_query` — dispatches a `mxdbAdminClientSqlQueryAction` to a specific client and awaits the result

Access is gated by a Bearer API key (`MXDB_MCP_API_KEY`) and an IP allowlist (`MXDB_MCP_IP_ALLOWLIST`). Both must be set in `process.env` for the endpoint to accept any request.

Files:
- `McpRouter.ts` — `dispatchMcpJsonRpc()` (JSON-RPC 2.0 dispatcher) and `registerMcpRoutes()` (registers `GET /mcp` health check and `POST /mcp` JSON-RPC handler on the Koa router)
- `tools.ts` — `createMcpTools()` — factory returning `listTools()` and `callTool()` for the two supported tools; `mxdb_client_sqlite_query` dispatches a socket action to the target client with a 10s default timeout
- `connectedClients.ts` — module-level registry (`Map<socketId, ConnectedClientInfo>`); `upsertConnectedClient`, `removeConnectedClient`, `listConnectedClients`; `__resetConnectedClientsForTests` (test-only)
- `mcpAuth.ts` — `isMcpAuthorized()` — validates Bearer token against `MXDB_MCP_API_KEY`; if token valid, checks caller IP against compiled allowlist
- `ipAllowlist.ts` — `compileIpAllowlist(raw)` — compiles comma-separated IPv4 exact addresses and CIDR ranges into a matcher function; invalid entries silently ignored

- [ ] **Step 1: Write the AGENTS.md file**

Create `src/server/mcp/AGENTS.md` with this exact content:

```markdown
# MCP endpoint (`src/server/mcp/`)

Server-side Model Context Protocol (MCP) endpoint — exposes JSON-RPC tools that let AI assistants inspect connected MXDB clients and query their local SQLite databases.

## Overview

The MCP endpoint listens at `POST /mcp` on the Koa HTTP server. It implements a minimal
JSON-RPC 2.0 server (no SSE; `GET /mcp` returns a stub). Two tools are exposed:

- **`mxdb_clients_list`** — returns the socket id, userId, and accountId of every currently connected client.
- **`mxdb_client_sqlite_query`** — sends a `mxdbAdminClientSqlQueryAction` socket event to a specific client and returns the SQL result. The client classifies the SQL and may require user consent for mutating queries.

Access requires **both** a valid Bearer API key and a caller IP that matches the configured allowlist. If either env var is absent the endpoint rejects all requests.

## Contents

### Route registration and dispatch
- `McpRouter.ts` — `registerMcpRoutes(router, input)` — attaches `GET /mcp` (health stub) and `POST /mcp` (JSON-RPC handler) to the supplied Koa router; `dispatchMcpJsonRpc(input)` — handles `initialize`, `tools/list`, and `tools/call` JSON-RPC methods

### MCP tools
- `tools.ts` — `createMcpTools(input)` — factory returning `listTools()` and `callTool({ name, arguments })`; `mxdb_client_sqlite_query` dispatches a socket action to the target client and races it against a 10 000 ms timeout (configurable via `input.defaultTimeoutMs`)

### Connected-client registry
- `connectedClients.ts` — module-level `Map<socketId, ConnectedClientInfo>`; `upsertConnectedClient` / `removeConnectedClient` (called on connect/disconnect); `listConnectedClients` (used by `mxdb_clients_list`); `__resetConnectedClientsForTests` (test-only reset — do not call in production code)

### Auth
- `mcpAuth.ts` — `isMcpAuthorized(input)` — validates `Authorization: Bearer <token>` against `MXDB_MCP_API_KEY`; if token matches, checks caller IP against the compiled allowlist; returns `{ ok: true }` or `{ ok: false; status: 401 | 403; error: string }`
- `ipAllowlist.ts` — `compileIpAllowlist(raw)` — compiles a comma-separated string of IPv4 addresses and CIDR ranges (e.g. `"127.0.0.1, 10.0.0.0/8"`) into a matcher function; invalid entries are silently ignored; empty/missing input produces a matcher that always returns `false`

## Architecture

Request lifecycle for `POST /mcp`:
1. `registerMcpRoutes` handler calls `isMcpAuthorized` — 401/403 if auth fails.
2. `dispatchMcpJsonRpc` parses the JSON-RPC envelope.
3. For `tools/call` with `mxdb_client_sqlite_query`, `createMcpTools.callTool` finds the target socket in `clientS2CInstances`, dispatches `emitAdminSqlQuery`, and awaits the response with a timeout.
4. The response is the `MXDBRemoteSqliteQueryResponse` returned by the client's `handleRemoteSqliteQuery`.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MXDB_MCP_API_KEY` | Yes (to accept any request) | Bearer token callers must supply in `Authorization` header |
| `MXDB_MCP_IP_ALLOWLIST` | Yes (to accept any request) | Comma-separated IPv4 exact addresses and/or CIDR ranges allowed to call the endpoint |

Both variables must be non-empty for any request to succeed. If either is absent, all requests are rejected.

## Ambiguities and gotchas

- **`connectedClients` is module-level state.** In a multi-worker deployment each process has its own registry — `mxdb_clients_list` will only return clients connected to the specific server instance receiving the MCP request. Sticky sessions or a shared registry would be needed for full visibility.
- **`GET /mcp` returns a plain-text stub, not an SSE stream.** SSE transport is not yet implemented. MCP callers must use HTTP POST.
- **Timeout errors surface as JSON-RPC error code -32000 with message `MXDB_REMOTE_SQL_TIMEOUT`.** A 10s default is used; override via `CreateMcpToolsInput.defaultTimeoutMs`.
- **`__resetConnectedClientsForTests` is exported for test isolation only.** Calling it in production code will silently disconnect all tracked clients from the registry.

## Related

- [`../../../common/mcpActions.ts`](../../../common/mcpActions.ts) — `mxdbAdminClientSqlQueryAction` socket action (S2C) dispatched by `tools.ts`
- [`../../../common/mcpModels.ts`](../../../common/mcpModels.ts) — `MXDBRemoteSqliteQueryRequest` / `MXDBRemoteSqliteQueryResponse` request/response shapes
- [`../../../client/remote-assistance/AGENTS.md`](../../../client/remote-assistance/AGENTS.md) — client-side handler that receives and executes the SQL query
- [`../AGENTS.md`](../AGENTS.md) — parent server directory
```

- [ ] **Step 2: Commit**

```
git add src/server/mcp/AGENTS.md
git commit -m "docs: add AGENTS.md for server/mcp"
```

---

## Task 3: Update `src/client/AGENTS.md` — new auth files and remote-assistance link

**Files:**
- Modify: `src/client/AGENTS.md`

**Two changes needed:**

**Change A — Auth section:** Add `dbReadyWait.ts` and `MxdbReadyContext.ts` to the existing `### Auth (\`auth/\`)` bullet list.

`dbReadyWait.ts` — `createDbReadyWaitHandle(timeoutMs)` — returns a `DbReadyWaitHandle` with `setIsDbReady`, `getIsDbReady`, and `waitForDbReady`; used to block socket actions until the encryption key is available; resolves `false` if the timeout elapses before the DB becomes ready.

`MxdbReadyContext.ts` — `MxdbReadyContext` (React context exposing `waitForDbReady()` and `getIsDbReady()`) and `DB_READY_TIMEOUT_MS = 3000`; consumed by socket action wrappers to gate calls until the DB is open.

**Change B — New section before Related:** Add a `### Remote assistance (\`remote-assistance/\`)` entry in the Contents section, with a link to the new AGENTS.md.

- [ ] **Step 1: Read `src/client/AGENTS.md`**

Read the file to locate the exact auth section text and the Related section.

- [ ] **Step 2: Add the two auth bullets**

In the Auth section, append these two bullets after the existing `MXDBSyncInner.tsx` bullet:

```markdown
- `dbReadyWait.ts` — `createDbReadyWaitHandle(timeoutMs)` — a handle with `setIsDbReady`, `getIsDbReady`, and `waitForDbReady`; resolves `true` once the encryption key is available, or `false` if the timeout elapses first; used to block socket actions until the DB is open
- `MxdbReadyContext.ts` — `MxdbReadyContext` (React context exposing `waitForDbReady()` and `getIsDbReady()`) and `DB_READY_TIMEOUT_MS = 3000`; consumed by socket action wrappers to gate calls until the DB is ready
```

- [ ] **Step 3: Add the remote-assistance section**

After the existing `### Components (\`components/UseRecord/\`)` section (or wherever is most logical in the Contents), add:

```markdown
### Remote assistance (`remote-assistance/`)
MCP-initiated remote SQL queries against the local SQLite database: consent gate, SQL classifier, socket action handler, and React context. See [remote-assistance/AGENTS.md](remote-assistance/AGENTS.md).
```

Also add a link to the Related section:
```markdown
- [remote-assistance/AGENTS.md](remote-assistance/AGENTS.md) — MCP-initiated remote SQL query handling
```

- [ ] **Step 4: Commit**

```
git add src/client/AGENTS.md
git commit -m "docs: update client/AGENTS.md with new auth files and remote-assistance link"
```

---

## Task 4: Update `src/server/AGENTS.md` — add mcp/ section

**Files:**
- Modify: `src/server/AGENTS.md`

**One change:** Add a `### MCP endpoint (\`mcp/\`)` entry to the Contents section, and a link in Related.

- [ ] **Step 1: Read `src/server/AGENTS.md`**

Read to find the Contents and Related sections.

- [ ] **Step 2: Add MCP entry to Contents**

In the Contents section, after the existing `### S2C synchronisation` entry, add:

```markdown
### MCP endpoint (`mcp/`)
JSON-RPC 2.0 server at `POST /mcp` exposing `mxdb_clients_list` and `mxdb_client_sqlite_query` tools. Auth: Bearer API key + IP allowlist. See [mcp/AGENTS.md](mcp/AGENTS.md).
```

- [ ] **Step 3: Add link to Related**

In the Related section, add:

```markdown
- [mcp/AGENTS.md](mcp/AGENTS.md) — MCP endpoint for AI-assistant access to connected clients
```

- [ ] **Step 4: Commit**

```
git add src/server/AGENTS.md
git commit -m "docs: add mcp/ entry to server/AGENTS.md"
```

---

## Task 5: Update `src/server/auth/AGENTS.md` — three new files

**Files:**
- Modify: `src/server/auth/AGENTS.md`

**Three new files to document:**

- `authDevicesContext.ts` — `AuthDevicesApi` interface (`listForUser`, `createInvite`, `setEnabled`, `deleteDevice`, `expireStalePendingInvites`) + module-level singleton pattern via `setAuthDevices(api)` / `useAuthDevices()`. Throws if `useAuthDevices()` is called before `setAuthDevices`.
- `useAuthDevices.ts` — barrel re-export of `AuthDevicesApi`, `setAuthDevices`, `useAuthDevices` from `authDevicesContext.ts`.
- `parseSessionTokenFromHandshake.ts` — `parseSessionTokenFromHandshake(input)` — extracts a session token from socket handshake cookies, checking `nexus_session` and `socketapi_session` cookie names (both checked for backward compatibility during the rename from socket-api → nexus), falling back to `input.sessionTokenFromAuth`.

- [ ] **Step 1: Read `src/server/auth/AGENTS.md`**

Read the file to find the Contents section and locate where to add the new entries.

- [ ] **Step 2: Add the three new file entries**

In the Contents section, after the existing "Dev tooling" subsection, add a new subsection:

```markdown
### Device management context
- `authDevicesContext.ts` — `AuthDevicesApi` interface (`listForUser`, `createInvite`, `setEnabled`, `deleteDevice`, `expireStalePendingInvites`) plus a module-level singleton pattern: `setAuthDevices(api)` registers the implementation at startup; `useAuthDevices()` returns it and throws if called before registration
- `useAuthDevices.ts` — barrel re-export of `AuthDevicesApi`, `setAuthDevices`, and `useAuthDevices`

### Session token parsing
- `parseSessionTokenFromHandshake.ts` — `parseSessionTokenFromHandshake(input)` — reads the session token from socket handshake cookies; checks both `nexus_session` and `socketapi_session` cookie names (the latter kept for backward compatibility after the socket-api → nexus rename); falls back to `input.sessionTokenFromAuth` if no cookie matches
```

- [ ] **Step 3: Commit**

```
git add src/server/auth/AGENTS.md
git commit -m "docs: add authDevicesContext, useAuthDevices, parseSessionTokenFromHandshake to server/auth/AGENTS.md"
```

---

## Task 6: Update `src/common/AGENTS.md` — MCP shared types

**Files:**
- Modify: `src/common/AGENTS.md`

**Two new files to document:**

- `mcpActions.ts` — `mxdbAdminClientSqlQueryAction` — S2C socket action (server→client) that triggers remote SQL execution on the client's local SQLite; used by the server MCP tools layer
- `mcpModels.ts` — `MXDBRemoteSqliteQueryRequest` (fields: `requestId`, `sql`, `params?`, `requestedBy`, `maxRows?`, `timeoutMs?`) and `MXDBRemoteSqliteQueryResponse` (fields: `requestId`, `rows`, `truncated?`, `elapsedMs`, `error?`)

- [ ] **Step 1: Read `src/common/AGENTS.md`**

Read the file to find the Contents section.

- [ ] **Step 2: Add MCP category**

In the Contents section, after the existing "Internal socket wiring" category, add a new category:

```markdown
### MCP / remote assistance
- `mcpActions.ts` — `mxdbAdminClientSqlQueryAction` — S2C socket action that triggers remote SQL execution on the target client's local SQLite; dispatched by the server MCP tools and handled by `src/client/remote-assistance/`
- `mcpModels.ts` — `MXDBRemoteSqliteQueryRequest` (sql, params, requestedBy, requestId, maxRows?, timeoutMs?) and `MXDBRemoteSqliteQueryResponse` (requestId, rows, elapsedMs, truncated?, error?)
```

- [ ] **Step 3: Commit**

```
git add src/common/AGENTS.md
git commit -m "docs: add MCP models and actions to common/AGENTS.md"
```

---

## Task 7: Update `README.md` env vars — add MCP variables

**Files:**
- Modify: `README.md`

**Add two new rows to the Environment variables table.** The `MXDB_MCP_API_KEY` and `MXDB_MCP_IP_ALLOWLIST` variables are read from `process.env` in `src/server/mcp/McpRouter.ts` and are required for the MCP endpoint to accept any request.

- [ ] **Step 1: Read `README.md`**

Read to find the exact Environment variables table.

- [ ] **Step 2: Add the two rows**

In the Environment variables table, add after the existing `MXDB_E2E_*` row:

```markdown
| `MXDB_MCP_API_KEY` | Server (MCP endpoint) | Bearer token that MCP callers must supply in the `Authorization` header. If unset, all `POST /mcp` requests are rejected with 401. |
| `MXDB_MCP_IP_ALLOWLIST` | Server (MCP endpoint) | Comma-separated IPv4 addresses and/or CIDR ranges (e.g. `"127.0.0.1, 10.0.0.0/8"`) permitted to call the MCP endpoint. If unset, all requests are rejected with 403. |
```

- [ ] **Step 3: Commit**

```
git add README.md
git commit -m "docs: add MXDB_MCP_API_KEY and MXDB_MCP_IP_ALLOWLIST to README env vars"
```

---

## Self-Review

**Spec coverage:**

| Finding | Task |
|---------|------|
| 1. `src/client/remote-assistance/` — no AGENTS.md | Task 1 ✅ |
| 2. `src/server/mcp/` — no AGENTS.md | Task 2 ✅ |
| 3. `src/client/AGENTS.md` missing dbReadyWait + MxdbReadyContext + remote-assistance link | Task 3 ✅ |
| 4. `src/server/AGENTS.md` missing mcp/ | Task 4 ✅ |
| 5. `src/server/auth/AGENTS.md` missing 3 new files | Task 5 ✅ |
| 6. `src/common/AGENTS.md` missing mcpActions + mcpModels | Task 6 ✅ |
| 7. README env vars missing MXDB_MCP_API_KEY + MXDB_MCP_IP_ALLOWLIST | Task 7 ✅ |

**Placeholder scan:** No TBD, TODO, or vague references. All content is concrete and sourced directly from reading the files.

**Type consistency:** Documentation only — no types defined.
