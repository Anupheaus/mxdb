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
- **`remoteSqliteHandler` does not throw.** All errors are returned as `{ error: { message: '...' } }` in the response, not thrown. The caller handles the socket action lifecycle.

## Related

- [`../../../common/mcpActions.ts`](../../../common/mcpActions.ts) — `mxdbAdminClientSqlQueryAction` socket action descriptor (S2C)
- [`../../../common/mcpModels.ts`](../../../common/mcpModels.ts) — `MXDBRemoteSqliteQueryRequest` / `MXDBRemoteSqliteQueryResponse`
- [`../../../server/mcp/AGENTS.md`](../../../server/mcp/AGENTS.md) — server-side MCP endpoint that initiates these queries
- [`../providers/dbs/AGENTS.md`](../providers/dbs/AGENTS.md) — `Db` whose `queryRaw` / `execRaw` are called here
