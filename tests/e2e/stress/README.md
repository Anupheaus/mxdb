# Stress Test Suite

End-to-end integration tests for the MXDB library under concurrent, adversarial conditions. The goal is to prove that the sync engine preserves data integrity across many simultaneous clients, network disruptions, and server restarts.

---

## What it tests

The suite runs a single long-lived test scenario (`stress.tests.ts`) that exercises:

1. **Concurrent multi-client writes** — 20 clients each independently create, update, and delete records at random intervals, all hitting the same MongoDB collection at once.
2. **Random deletes** — each operation has an 8% chance of becoming a delete (capped at half the max record count), verifying that tombstones propagate correctly and records do not ghost-resurrect.
3. **Simulated network latency** — every CRUD call is preceded by a random 10–80 ms delay, mimicking real-world socket round-trip times.
4. **Flaky clients** — 3 of the 20 clients cycle through random disconnects (2–8 s down) and reconnects (5–15 s up) for most of the workload duration, verifying that clients can catch up after offline periods.
5. **Mid-workload server restart** — at 15 s into the 40 s workload, the server process is killed and respawned on the same port; clients are expected to reconnect and resync automatically with no data loss.
6. **Staggered client connections** — clients connect spread over 5 s to mirror real-world staggered user arrivals rather than a thundering herd.

---

## How it tests

### Workload phase (`stressRandomMixWorkload.ts`)

All 20 clients run concurrently as independent async workers for 40 s. Each worker loop:

1. Waits a random CRUD gap (2–4 s) then a random network latency (10–80 ms).
2. Rolls a delete (8% chance) against a randomly chosen record the client currently sees.
3. Otherwise creates a new record (if below the 20-record cap) or mutates an existing one by randomly changing 1–4 fields (`value`, `name`, `metadata`, `tags`).

Simultaneously, three background tasks run in parallel with the workers:
- **Server restart loop** — fires at 15 s.
- **Connectivity disruption loops** — one per flaky client.
- All workers and background tasks race to their respective deadlines with `Promise.all`.

### Settle phase

After the workload deadline, the test polls until the server's live records exactly match the client oracle (or times out at 90 s). This gives in-flight replication and reconnection sync time to complete.

A final grace period of 10 s follows, then the test waits for all clients to reach a fully idle state (no pending sync activity, all connected) before taking the final snapshot.

---

## Oracles and integrity checks

The test uses two independent oracles that must all agree with each other and with the server at assertion time.

### 1. Client oracle (`stressClientOracle.ts`)

Queries every client's local IndexedDB for its current live rows. Conflicts between clients are resolved by ULID-based last-write-wins: for each record ID, the client whose last audit entry ULID is lexicographically greatest wins. This mirrors the exact same ordering the sync engine uses internally.

### 2. Records-of-truth (`recordsOfTruth.ts`)

A harness-side audit log that mirrors what the client `DbCollection` writes, using the same auditor functions (`createAuditFrom`, `updateAuditWith`, `auditor.delete`). Every time the test harness calls `client.upsert()` or `client.remove()`, the corresponding function is called on the truth log:

- `recordHarnessUpsert(clientId, prev, next)` — creates a `Created` entry for new IDs, or appends an `Updated` entry for existing ones (including post-delete updates, which do not resurrect the record — only a `Restored` entry can do that).
- `recordHarnessDelete(recordId)` — directly appends a `Deleted` entry, bypassing the short-circuit that would normally skip a double-delete, to match server-side merge semantics for racing deletes.

`getExpectedState()` materialises live records by replaying each audit through the same `createRecordFrom` function the sync engine uses, so deleted IDs naturally produce no output.

### Integrity assertion (`stressIntegrityAssertions.ts`)

`assertIntegrity` compares the server's live MongoDB documents against the client oracle and throws with a detailed diff if any of these fail:

| Check | What it detects |
|---|---|
| Missing IDs | Records the oracle expects but the server doesn't have |
| Extra IDs | Records the server has that the oracle doesn't know about |
| Value mismatches | Records present on both sides but with different field values |

### Audit-level comparison (`truthVsServerAuditCompare.ts`)

Beyond record values, the final report compares the raw audit documents in MongoDB (`_sync` collection) against the records-of-truth audit log entry-by-entry. This catches subtler bugs — e.g. lost audit entries, duplicate entries, or unexpected `Branched` anchor entries (which are disallowed in the stress test).

### Final report (`stressFinalReport.ts`)

Emitted once at the end (and on teardown if the test crashes early). Logs a summary that covers all four alignment checks:

- **Client oracle vs server** — did every client's view of live records end up on the server?
- **Records-of-truth vs client oracle** — does the harness's op-log replay agree with what clients actually see?
- **Records-of-truth vs server** — does the harness's op-log replay agree with what MongoDB actually holds?
- **Audit-level truth vs server** — do the raw audit entry sequences in MongoDB match the harness's audit trail exactly?

All four must pass for the test to succeed.

---

## Key configuration (`config.ts`)

| Parameter | Default | Meaning |
|---|---|---|
| `NUM_CLIENTS` | 20 | Concurrent client instances |
| `E2E_STRESS_MAX_RECORDS` | 20 | Soft cap on live rows (creates blocked above this) |
| `E2E_STRESS_DELETE_ROLL_CHANCE` | 0.08 | Per-operation probability of a delete |
| `TEST_DURATION_MS` | 40 000 | Workload window |
| `SERVER_RESTART_AT_MS` | 15 000 | When to kill and restart the server (0 = disabled) |
| `STAGGER_CONNECT_MS` | 5 000 | Window over which initial client connections are spread |
| `CRUD_GAP_MIN/MAX_MS` | 2 000–4 000 | Think-time between operations per client |
| `NETWORK_LATENCY_MIN/MAX_MS` | 10–80 | Simulated socket RTT per operation |
| `CONNECTIVITY_ISSUE_CLIENT_COUNT` | 3 | Number of clients with random disconnects |
| `CONNECTIVITY_DOWN_MIN/MAX_MS` | 2 000–8 000 | Disconnect duration for flaky clients |
| `CONNECTIVITY_UP_MIN/MAX_MS` | 5 000–15 000 | Connected window between disruptions |
| `QUIET_PERIOD_TIMEOUT_MS` | 90 000 | Settle-phase timeout |
| `FINAL_SYNC_GRACE_MS` | 10 000 | Extra wait after settle before final assertion |

---

## Logs

Each run writes a timestamped NDJSON log to `tests/e2e/stress/logs/stress-<timestamp>.log`. Each line is a structured event (`test_start`, `client_upsert`, `client_remove`, `server_restart`, `client_connect`, `client_disconnect`, `sync_response`, `validation_summary`, `error`, …) with a `phase` field marking which stage of the test emitted it. The final `validation_summary` line is the definitive pass/fail record for the run.

---

## Running

```bash
pnpm vitest run tests/e2e/stress/stress.tests.ts
```

The test has a 300 s timeout for the main `it` block and a 90 s timeout for `beforeAll` (client connections).
