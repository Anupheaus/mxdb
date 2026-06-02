# Remote MCP: Client-SQLite Queries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a remotely accessible MCP-over-HTTP endpoint to the MXDB server that can list connected clients and run SQLite queries on a chosen connected client, with API-key + IP-allowlist auth and a client-side “ask-once per session” consent gate for mutating SQL.

**Architecture:** Add Koa routes (`/mcp`) guarded by env-based auth. Track connected sockets with enumerable `Map`s. Implement a server→client Nexus action for SQLite query requests that the client executes via its SQLite worker layer; mutating SQL triggers a one-time async consent callback provided by the consumer.

**Tech Stack:** Koa, Socket.IO, `@anupheaus/nexus` actions/handlers, Vitest.

---

## File map (create/modify)

**Create (server):**
- `src/server/mcp/McpRouter.ts` — Koa router that implements `/mcp` (HTTP transport) and dispatches tools
- `src/server/mcp/mcpAuth.ts` — API key + IP allowlist guard middleware/helpers
- `src/server/mcp/ipAllowlist.ts` — CIDR/IP parsing + matcher (unit-testable)
- `src/server/mcp/connectedClients.ts` — enumerable registry helpers (wrap `Map`s) + listing shape
- `src/server/mcp/sqlClassifier.ts` — read-only vs mutating SQL classifier
- `src/server/mcp/tools.ts` — tool implementations (`mxdb_clients_list`, `mxdb_client_sqlite_query`)

**Modify (server):**
- `src/server/startAuthenticatedServer.ts` — replace `WeakMap` → `Map`, wire connected client registry, cleanup on disconnect
- `src/server/internalModels.ts` — (if needed) add config knobs for MCP enablement (or env-only if preferred)
- `src/server/index.ts` — export any new server-side types if part of public surface
- `src/server/startServer.ts` — mount the MCP router during `onRegisterRoutes` (or inside startup) so it’s available

**Create (common):**
- `src/common/mcpActions.ts` — define the new server→client action type(s) (keeps common the shared boundary)
- `src/common/mcpModels.ts` — request/response types for remote SQLite query
- `src/common/index.ts` — re-export if this is part of public API

**Modify (client):**
- `src/client/MXDBSync.tsx` and/or `src/client/auth/MXDBSyncInner.tsx` — accept and pass down `remoteAssistance` config
- `src/client/providers/AGENTS.md` or a new file under `src/client/providers/remote-assistance/` (if a provider is introduced)
- `src/client/providers/server-to-client/ServerToClientProvider.tsx` (or a new small provider) — register action handler for SQLite query requests
- Potentially `src/client/providers/dbs/Db.ts` (or the right Db abstraction) — add a minimal method to run raw SQL query with params via the worker client

**Docs:**
- Modify `AGENTS.md` (root) — link to `src/server/AGENTS.md`/`src/client/AGENTS.md` sections
- Modify `src/server/AGENTS.md` — document MCP routes, env vars, and tool list
- Modify `src/client/AGENTS.md` — document `remoteAssistance.onRemoteMutatingSqlRequested` and ask-once semantics

**Tests:**
- Create `src/server/mcp/ipAllowlist.tests.ts`
- Create `src/server/mcp/sqlClassifier.tests.ts`
- Create `src/server/mcp/mcpAuth.tests.ts`
- Create `src/client/remoteAssistance.tests.ts` (or colocated near the implementation) for ask-once memoization
- Create an integration-ish test under `tests/` that spins up a server+client (as done elsewhere) and runs the MCP HTTP calls end-to-end

---

### Task 1: Add IP allowlist parsing/matching (server, unit tests)

**Files:**
- Create: `src/server/mcp/ipAllowlist.ts`
- Test: `src/server/mcp/ipAllowlist.tests.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { compileIpAllowlist } from './ipAllowlist';

describe('compileIpAllowlist', () => {
  it('matches exact IPv4', () => {
    const allow = compileIpAllowlist('1.2.3.4');
    expect(allow('1.2.3.4')).toBe(true);
    expect(allow('1.2.3.5')).toBe(false);
  });

  it('matches IPv4 CIDR', () => {
    const allow = compileIpAllowlist('10.0.0.0/24');
    expect(allow('10.0.0.1')).toBe(true);
    expect(allow('10.0.1.1')).toBe(false);
  });

  it('supports comma-separated entries with spaces', () => {
    const allow = compileIpAllowlist('1.1.1.1, 10.0.0.0/24');
    expect(allow('1.1.1.1')).toBe(true);
    expect(allow('10.0.0.2')).toBe(true);
    expect(allow('2.2.2.2')).toBe(false);
  });
});
```

- [ ] **Step 2: Implement minimal matcher**
- [ ] **Step 3: Run unit tests**

Run: `pnpm test -- src/server/mcp/ipAllowlist.tests.ts`  
Expected: PASS

---

### Task 2: MCP auth guard (API key + IP allowlist) + tests

**Files:**
- Create: `src/server/mcp/mcpAuth.ts`
- Test: `src/server/mcp/mcpAuth.tests.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { isMcpAuthorized } from './mcpAuth';

describe('isMcpAuthorized', () => {
  it('rejects when api key missing', () => {
    expect(isMcpAuthorized({
      ip: '1.2.3.4',
      authorizationHeader: undefined,
      expectedApiKey: 'secret',
      ipAllowlist: '1.2.3.4/32',
    }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Implement header parsing and allowlist check**
- [ ] **Step 3: Run tests**

Run: `pnpm test -- src/server/mcp/mcpAuth.tests.ts`  
Expected: PASS

---

### Task 3: SQL classifier (mutating vs read-only) + tests

**Files:**
- Create: `src/server/mcp/sqlClassifier.ts`
- Test: `src/server/mcp/sqlClassifier.tests.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { classifySql } from './sqlClassifier';

describe('classifySql', () => {
  it('treats SELECT as read-only', () => {
    expect(classifySql('select 1').isMutating).toBe(false);
  });
  it('treats WITH as read-only', () => {
    expect(classifySql('with c as (select 1) select * from c').isMutating).toBe(false);
  });
  it('treats UPDATE as mutating', () => {
    expect(classifySql('update t set a=1').isMutating).toBe(true);
  });
});
```

- [ ] **Step 2: Implement classifier**
- [ ] **Step 3: Run tests**

Run: `pnpm test -- src/server/mcp/sqlClassifier.tests.ts`  
Expected: PASS

---

### Task 4: Define server→client query action types (common) + wire client handler

**Files:**
- Create: `src/common/mcpModels.ts`
- Create: `src/common/mcpActions.ts`
- Modify: `src/common/index.ts` (as needed)
- Modify: `src/client/providers/server-to-client/ServerToClientProvider.tsx` (or new provider) to handle the new action

- [ ] **Step 1: Add action + types**
- [ ] **Step 2: Add client handler that runs SQL and returns rows**
- [ ] **Step 3: Add unit test for client ask-once memoization (next task)**

---

### Task 5: Client-side mutating consent (ask-once) + tests

**Files:**
- Modify: `src/client/MXDBSync.tsx` (or `MXDBSyncInner.tsx`) to accept `remoteAssistance`
- Create/Modify: client helper module (location decided during implementation)
- Test: `src/client/remoteAssistance.tests.ts`

- [ ] **Step 1: Write failing test for ask-once**
- [ ] **Step 2: Implement memoized consent flow**
- [ ] **Step 3: Ensure handler only prompts on mutating statements**
- [ ] **Step 4: Run tests**

---

### Task 6: Connected clients registry via Map + listing shape

**Files:**
- Modify: `src/server/startAuthenticatedServer.ts`
- Create: `src/server/mcp/connectedClients.ts`
- Test: light unit tests or covered by integration test

- [ ] **Step 1: Replace WeakMap→Map**
- [ ] **Step 2: Ensure disconnect cleanup**
- [ ] **Step 3: Implement listConnectedClients()**

---

### Task 7: MCP router + tools + server integration

**Files:**
- Create: `src/server/mcp/McpRouter.ts`
- Create: `src/server/mcp/tools.ts`
- Modify: `src/server/startAuthenticatedServer.ts` or `startServer.ts` to mount router

- [ ] **Step 1: Implement `/mcp` route with auth guard**
- [ ] **Step 2: Implement `mxdb_clients_list` tool**
- [ ] **Step 3: Implement `mxdb_client_sqlite_query` tool (dispatch to socket)**
- [ ] **Step 4: Enforce timeouts and response-size limits**

---

### Task 8: End-to-end test (server + client + MCP HTTP)

**Files:**
- Create: `tests/mcp/remote-assistance.e2e.tests.ts` (or consistent tests folder)

- [ ] **Step 1: Spin up server and client using existing e2e patterns**
- [ ] **Step 2: Call MCP `mxdb_clients_list` and assert the client appears**
- [ ] **Step 3: Run read-only query and assert result**
- [ ] **Step 4: Run mutating query and assert denial without callback**
- [ ] **Step 5: Run mutating query with callback returning true and assert it executes**

---

### Task 9: Update AGENTS.md documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `src/server/AGENTS.md`
- Modify: `src/client/AGENTS.md`

- [ ] **Step 1: Add “Remote MCP” section to server/client docs**
- [ ] **Step 2: Document env vars and auth**
- [ ] **Step 3: Document client callback + semantics**
- [ ] **Step 4: Add pointers to spec**

