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
