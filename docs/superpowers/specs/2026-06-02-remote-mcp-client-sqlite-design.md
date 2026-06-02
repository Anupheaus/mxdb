# Remote MCP: Connected Clients + Client-SQLite Queries

**Date:** 2026-06-02  
**Status:** Draft  
**Scope:** `mxdb` server + `mxdb` client

---

## Goal

Expose a **remotely accessible** MCP endpoint on the MXDB server so an AI client can:

- list **currently connected** Socket.IO clients, including their user identity details
- run SQL queries that execute on a chosen client’s **local SQLite database**, returning results back to the AI

This is intended as a *remote assistance / diagnostics* capability.

---

## Non-goals

- multi-tenant authorization constraints (per-account/user allowlists), scopes, or RBAC
- persistent per-user consent storage (no localStorage; page refresh re-prompts)
- long-running interactive sessions beyond request/response

---

## Architecture Summary

### Transport

- Add **MCP-over-HTTP** routes to the existing Koa server (same process as Socket.IO):
  - `POST /mcp` — MCP request endpoint (JSON)
  - `GET /mcp` — MCP event stream (SSE) if/when needed by the MCP transport

### Auth

- Requests are accepted only when BOTH are true:
  - **API key** matches: `Authorization: Bearer <key>` equals `process.env.MXDB_MCP_API_KEY`
  - **Client IP** is in allowlist: `process.env.MXDB_MCP_IP_ALLOWLIST`

Allowlist parsing:
- comma-separated list of entries
- each entry is either a single IP (`1.2.3.4`) or CIDR (`1.2.3.0/24`)

If auth fails: reject with `401` (bad/missing API key) or `403` (IP not allowed).

### Connected-client registry

Replace current `WeakMap` connection tracking in `startAuthenticatedServer.ts` with **enumerable `Map`s**:

- `clientS2CInstances: Map<Socket, ServerToClientSynchronisation>`
- `connectedUsers: Map<Socket, MXDBUser>`
- `connectedAccounts: Map<Socket, MXDBAccount>`
- `disconnectReasons: Map<Socket, string>`

Cleanup on disconnect:
- delete socket key from all maps
- cancel/reject any pending per-socket query requests (avoid leaks / hung MCP calls)

### Query forwarding

Define a new **server→client** Nexus action to request SQLite execution on a specific connected client:

- Action name: `mxdbAdminClientSqlQueryAction` (exact name TBD)
- Request shape:
  - `requestId: string`
  - `sql: string`
  - `params?: unknown[]`
  - `maxRows?: number` (server default)
  - `timeoutMs?: number` (server default)
- Response shape:
  - `requestId: string`
  - `rows: Record<string, unknown>[]`
  - `truncated?: boolean`
  - `elapsedMs: number`
  - `error?: { message: string }`

Server execution flow:
1. MCP handler validates inputs and locates target socket by `socketId`
2. server dispatches the action to that socket and awaits response
3. server enforces timeout and response size limits
4. result returned to MCP caller

Client execution flow:
1. client receives request via `useServerActionHandler(...)`
2. classify SQL as read-only vs mutating
3. if mutating: request user consent (see below)
4. execute SQL against client SQLite (through existing SQLite worker client)
5. return rows back to server

---

## Mutating SQL Consent (Client-side, Ask-once Per Session)

### Requirements

- Mutating statements are allowed only when the client-side consumer approves.
- Approval is requested via an async callback on the MXDB client component/API.
- The callback is invoked:
  - **only when** a mutating statement is requested
  - **only once per session** (memoized in-memory)
- If the page refreshes, the session resets and the user can be asked again.

### Proposed client surface

Add an optional prop/config on the client side (exact location: `MXDBSync` / `useMXDB` entrypoint):

```ts
type RemoteSqlMutatingRequestInfo = {
  sql: string;
  params?: unknown[];
  requestedBy: 'mcp';
};

type MXDBRemoteAssistanceConfig = {
  onRemoteMutatingSqlRequested?: (info: RemoteSqlMutatingRequestInfo) => Promise<boolean>;
};
```

Client keeps an in-memory session value:
- `mutatingSqlApproved: boolean | null` (null = not asked yet)

Behavior:
- If mutating and `mutatingSqlApproved === true`: proceed
- If mutating and `mutatingSqlApproved === false`: reject
- If mutating and `mutatingSqlApproved === null`:
  - if callback missing: reject
  - else await callback; store result; allow/deny accordingly

---

## SQL Classification

Purpose: decide whether client must request consent.

Minimal classifier (string-based, best-effort):
- Trim leading whitespace and SQL comments
- Look at first keyword:
  - **Read-only**: `SELECT`, `WITH` (and optionally `EXPLAIN` when explain-only)
  - **Mutating**: everything else (includes `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`, `ALTER`, `PRAGMA`, `ATTACH`, etc.)

This errs on the side of prompting/denying.

---

## MCP Tools

The MCP server exposes tools:

1. `mxdb_clients_list`
   - Returns array of connected clients:
     - `socketId`
     - `userId`
     - `accountId?`
     - `connectedAt`
     - `displayName?` (if available)

2. `mxdb_client_sqlite_query`
   - Params:
     - `socketId: string`
     - `sql: string`
     - `params?: unknown[]`
   - Returns:
     - rows + metadata (truncation/time)
   - Mutating statements will prompt the end-user (once per session) on that client.

---

## Limits & Safety

Server-side defaults (configurable constants/env):
- `timeoutMs` default (e.g. 10_000)
- `maxRows` default (e.g. 1_000)
- `maxResponseBytes` default (e.g. 1_000_000)

Client-side:
- enforce `maxRows` by applying `LIMIT` when possible (or truncate after read)
- never return arbitrarily huge payloads

---

## Logging / Auditing

Server logs:
- MCP request start/end with:
  - caller IP
  - tool name
  - socketId
  - userId (if resolved)
  - elapsed time
  - result size (rows/bytes)

Client logs:
- when mutating consent prompt is triggered
- whether allowed/denied

---

## Testing Plan

- Unit:
  - IP allowlist CIDR parsing
  - SQL classifier (read vs mutating)
  - “ask once per session” consent memoization
- Integration / e2e:
  - Connect a client, list it via MCP
  - Run a read-only query, verify results
  - Run a mutating query:
    - denied when callback missing
    - prompts once and then allows subsequent mutating queries without re-prompt

