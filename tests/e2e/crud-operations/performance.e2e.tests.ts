import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { E2eTestRecord } from '../setup/types';
import {
  resetE2E,
  setupE2E,
  teardownE2E,
  useClient,
  useServer,
  waitForAllClientsIdle,
  waitForClientRecord,
} from '../setup';
import { connectBoth, newRecordId } from './utils';

// ─── Thresholds ──────────────────────────────────────────────────────────────
// These are intentionally generous to avoid flakiness on slow CI machines.
// They exist to catch gross regressions (e.g. O(n²) behaviour), not to benchmark.

const THRESHOLDS = {
  /** Time to mount a client and establish a socket connection (ms). */
  clientConnect: 1_000,
  /** Per-record write time budget when upserting N records sequentially (ms). */
  upsertPerRecord: 50,
  /** Per-record time budget when reading N records back from local SQLite (ms). */
  readLocalPerRecord: 5,
  /** Per-record time budget when updating N records sequentially (ms). */
  updatePerRecord: 50,
  /** Per-record time budget when deleting N records sequentially (ms). */
  deletePerRecord: 50,
  /** Total time for N records to propagate from one client to another after sync (ms). */
  syncPropagationTotal: 3_000,
  /** Time for a client to reconnect and fully sync a queue of N records (ms). */
  offlineSyncTotal: 10_000,
  /** Time to read all live records from the server Mongo collection (ms). */
  serverReadAll: 1_000,
  /** Time to subscribe to get-all and receive the initial snapshot of N records (ms). */
  getAllSubscription: 3_000,
  /**
   * Total time for a single update on a record that already has DEEP_AUDIT_COUNT audit
   * entries, including the full server-side merge + replay + MongoDB write round-trip.
   * Exists to catch O(n) or O(n²) regressions in audit processing as history grows.
   */
  deepAuditUpdateMs: 5_000,
} as const;

// ─── Record counts ────────────────────────────────────────────────────────────
const SMALL = 10;
const MEDIUM = 50;
/**
 * Number of audit entries to build on a single record before timing the final
 * update. Reproduces the "700 audit entries" slowness regression.
 */
const DEEP_AUDIT_COUNT = 700;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildRecords(count: number, clientId: string, prefix: string): E2eTestRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    id: newRecordId(`${prefix}-${i}`),
    clientId,
    value: `value-${i}`,
  }));
}

async function upsertAll(client: ReturnType<typeof useClient>, records: E2eTestRecord[]): Promise<void> {
  for (const record of records) {
    await client.upsert(record);
  }
}

async function removeAll(client: ReturnType<typeof useClient>, ids: string[]): Promise<void> {
  for (const id of ids) {
    await client.remove(id);
  }
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('e2e performance tests', () => {
  beforeAll(async () => {
    await setupE2E();
  }, 90_000);

  beforeEach(async () => {
    await resetE2E();
  });

  afterAll(async () => {
    await teardownE2E();
  }, 30_000);

  // ── Client connection ───────────────────────────────────────────────────────

  it(`client connects within ${THRESHOLDS.clientConnect}ms`, async () => {
    const a = useClient('a');
    const start = Date.now();
    await a.connect();
    const elapsed = Date.now() - start;

    expect(
      elapsed,
      `connect took ${elapsed}ms, threshold ${THRESHOLDS.clientConnect}ms`,
    ).toBeLessThan(THRESHOLDS.clientConnect);
  }, 30_000);

  // ── Writes ──────────────────────────────────────────────────────────────────

  it(`upsert ${SMALL} records: total time within budget`, async () => {
    const a = useClient('a');
    await a.connect();

    const records = buildRecords(SMALL, 'a', 'perf-write-sm');
    const start = Date.now();
    await upsertAll(a, records);
    const elapsed = Date.now() - start;

    const budget = THRESHOLDS.upsertPerRecord * SMALL;
    expect(
      elapsed,
      `upsert ${SMALL} records took ${elapsed}ms, budget ${budget}ms`,
    ).toBeLessThan(budget);
  }, 120_000);

  it(`upsert ${MEDIUM} records: total time within budget`, async () => {
    const a = useClient('a');
    await a.connect();

    const records = buildRecords(MEDIUM, 'a', 'perf-write-md');
    const start = Date.now();
    await upsertAll(a, records);
    const elapsed = Date.now() - start;

    const budget = THRESHOLDS.upsertPerRecord * MEDIUM;
    expect(
      elapsed,
      `upsert ${MEDIUM} records took ${elapsed}ms, budget ${budget}ms`,
    ).toBeLessThan(budget);
  }, 120_000);

  // ── Local reads ─────────────────────────────────────────────────────────────

  it(`read ${SMALL} local records: total time within budget`, async () => {
    const a = useClient('a');
    await a.connect();

    const records = buildRecords(SMALL, 'a', 'perf-read-sm');
    await upsertAll(a, records);
    await waitForAllClientsIdle([a]);

    const start = Date.now();
    for (const record of records) {
      await a.getLocalRecord(record.id);
    }
    const elapsed = Date.now() - start;

    const budget = THRESHOLDS.readLocalPerRecord * SMALL;
    expect(
      elapsed,
      `read ${SMALL} local records took ${elapsed}ms, budget ${budget}ms`,
    ).toBeLessThan(budget);
  }, 120_000);

  it(`read ${MEDIUM} local records: total time within budget`, async () => {
    const a = useClient('a');
    await a.connect();

    const records = buildRecords(MEDIUM, 'a', 'perf-read-md');
    await upsertAll(a, records);
    await waitForAllClientsIdle([a]);

    const start = Date.now();
    for (const record of records) {
      await a.getLocalRecord(record.id);
    }
    const elapsed = Date.now() - start;

    const budget = THRESHOLDS.readLocalPerRecord * MEDIUM;
    expect(
      elapsed,
      `read ${MEDIUM} local records took ${elapsed}ms, budget ${budget}ms`,
    ).toBeLessThan(budget);
  }, 120_000);

  // ── Updates ─────────────────────────────────────────────────────────────────

  it(`update ${SMALL} records: total time within budget`, async () => {
    const a = useClient('a');
    await a.connect();

    const records = buildRecords(SMALL, 'a', 'perf-upd-sm');
    await upsertAll(a, records);
    await waitForAllClientsIdle([a]);

    const start = Date.now();
    for (const record of records) {
      await a.upsert({ ...record, value: 'updated' });
    }
    const elapsed = Date.now() - start;

    const budget = THRESHOLDS.updatePerRecord * SMALL;
    expect(
      elapsed,
      `update ${SMALL} records took ${elapsed}ms, budget ${budget}ms`,
    ).toBeLessThan(budget);
  }, 120_000);

  it(`update ${MEDIUM} records: total time within budget`, async () => {
    const a = useClient('a');
    await a.connect();

    const records = buildRecords(MEDIUM, 'a', 'perf-upd-md');
    await upsertAll(a, records);
    await waitForAllClientsIdle([a]);

    const start = Date.now();
    for (const record of records) {
      await a.upsert({ ...record, value: 'updated' });
    }
    const elapsed = Date.now() - start;

    const budget = THRESHOLDS.updatePerRecord * MEDIUM;
    expect(
      elapsed,
      `update ${MEDIUM} records took ${elapsed}ms, budget ${budget}ms`,
    ).toBeLessThan(budget);
  }, 120_000);

  // ── Deletes ─────────────────────────────────────────────────────────────────

  it(`delete ${SMALL} records: total time within budget`, async () => {
    const a = useClient('a');
    await a.connect();

    const records = buildRecords(SMALL, 'a', 'perf-del-sm');
    await upsertAll(a, records);
    await waitForAllClientsIdle([a]);

    const start = Date.now();
    await removeAll(a, records.map(r => r.id));
    const elapsed = Date.now() - start;

    const budget = THRESHOLDS.deletePerRecord * SMALL;
    expect(
      elapsed,
      `delete ${SMALL} records took ${elapsed}ms, budget ${budget}ms`,
    ).toBeLessThan(budget);
  }, 120_000);

  it(`delete ${MEDIUM} records: total time within budget`, async () => {
    const a = useClient('a');
    await a.connect();

    const records = buildRecords(MEDIUM, 'a', 'perf-del-md');
    await upsertAll(a, records);
    await waitForAllClientsIdle([a]);

    const start = Date.now();
    await removeAll(a, records.map(r => r.id));
    const elapsed = Date.now() - start;

    const budget = THRESHOLDS.deletePerRecord * MEDIUM;
    expect(
      elapsed,
      `delete ${MEDIUM} records took ${elapsed}ms, budget ${budget}ms`,
    ).toBeLessThan(budget);
  }, 120_000);

  // ── Server read ─────────────────────────────────────────────────────────────

  it(`server readLiveRecords with ${MEDIUM} rows: within ${THRESHOLDS.serverReadAll}ms`, async () => {
    const a = useClient('a');
    await a.connect();

    const records = buildRecords(MEDIUM, 'a', 'perf-srv-read');
    await upsertAll(a, records);
    await waitForAllClientsIdle([a]);

    const start = Date.now();
    const rows = await useServer().readLiveRecords();
    const elapsed = Date.now() - start;

    expect(rows.length).toBeGreaterThanOrEqual(MEDIUM);
    expect(
      elapsed,
      `server readLiveRecords took ${elapsed}ms, threshold ${THRESHOLDS.serverReadAll}ms`,
    ).toBeLessThan(THRESHOLDS.serverReadAll);
  }, 120_000);

  // ── Cross-client sync propagation ────────────────────────────────────────────

  it(`${SMALL} records written by A propagate to B via get-all within ${THRESHOLDS.syncPropagationTotal}ms`, async () => {
    const a = useClient('a');
    const b = useClient('b');
    await connectBoth(a, b);
    await b.subscribeGetAll();

    const records = buildRecords(SMALL, 'a', 'perf-sync-sm');

    const start = Date.now();
    await upsertAll(a, records);
    await Promise.all(records.map(r => waitForClientRecord(b, r.id, `B has ${r.id}`)));
    const elapsed = Date.now() - start;

    expect(
      elapsed,
      `sync of ${SMALL} records to B took ${elapsed}ms, threshold ${THRESHOLDS.syncPropagationTotal}ms`,
    ).toBeLessThan(THRESHOLDS.syncPropagationTotal);

    const snap = b.getGetAllSubscriptionSnapshot();
    const snapIds = new Set(snap.map(r => r.id));
    for (const record of records) {
      expect(snapIds.has(record.id), `B snapshot missing ${record.id}`).toBe(true);
    }
  }, 120_000);

  // ── get-all subscription initial snapshot ────────────────────────────────────

  it(`get-all subscription delivers ${MEDIUM} existing records within ${THRESHOLDS.getAllSubscription}ms`, async () => {
    const a = useClient('a');
    const b = useClient('b');
    await a.connect();

    const records = buildRecords(MEDIUM, 'a', 'perf-getall-snap');
    await upsertAll(a, records);
    await waitForAllClientsIdle([a]);

    await b.connect();
    const ids = new Set(records.map(r => r.id));
    const start = Date.now();
    await b.subscribeGetAll();
    await Promise.all(records.map(r => waitForClientRecord(b, r.id, `B has ${r.id}`)));
    const elapsed = Date.now() - start;

    const snap = b.getGetAllSubscriptionSnapshot();
    const snapIds = new Set(snap.map(r => r.id));
    for (const id of ids) {
      expect(snapIds.has(id), `B get-all snapshot missing ${id}`).toBe(true);
    }

    expect(
      elapsed,
      `get-all snapshot of ${MEDIUM} records took ${elapsed}ms, threshold ${THRESHOLDS.getAllSubscription}ms`,
    ).toBeLessThan(THRESHOLDS.getAllSubscription);
  }, 120_000);

  // ── Offline queue sync ───────────────────────────────────────────────────────

  it(`${SMALL} offline upserts sync to server after reconnect within ${THRESHOLDS.offlineSyncTotal}ms`, async () => {
    const a = useClient('a');
    await a.connect();
    await a.disconnect();

    const records = buildRecords(SMALL, 'a', 'perf-offline-sm');
    await upsertAll(a, records);

    const start = Date.now();
    await a.reconnect();
    await waitForAllClientsIdle([a]);
    await Promise.all(
      records.map(r =>
        useServer().waitForLiveRecord(r.id, { timeoutMs: THRESHOLDS.offlineSyncTotal }),
      ),
    );
    const elapsed = Date.now() - start;

    expect(
      elapsed,
      `offline sync of ${SMALL} records took ${elapsed}ms, threshold ${THRESHOLDS.offlineSyncTotal}ms`,
    ).toBeLessThan(THRESHOLDS.offlineSyncTotal);
  }, 120_000);

  it(`${MEDIUM} offline upserts sync to server after reconnect within ${THRESHOLDS.offlineSyncTotal}ms`, async () => {
    const a = useClient('a');
    await a.connect();
    await a.disconnect();

    const records = buildRecords(MEDIUM, 'a', 'perf-offline-md');
    await upsertAll(a, records);

    const start = Date.now();
    await a.reconnect();
    await waitForAllClientsIdle([a]);
    await Promise.all(
      records.map(r =>
        useServer().waitForLiveRecord(r.id, { timeoutMs: THRESHOLDS.offlineSyncTotal }),
      ),
    );
    const elapsed = Date.now() - start;

    expect(
      elapsed,
      `offline sync of ${MEDIUM} records took ${elapsed}ms, threshold ${THRESHOLDS.offlineSyncTotal}ms`,
    ).toBeLessThan(THRESHOLDS.offlineSyncTotal);
  }, 120_000);

  // ── Deep audit history ───────────────────────────────────────────────────────

  it(`single update on a record with ${DEEP_AUDIT_COUNT} existing audit entries: within ${THRESHOLDS.deepAuditUpdateMs}ms`, async () => {
    const a = useClient('a');
    await a.connect();

    // ── Setup (not timed): build DEEP_AUDIT_COUNT audit entries on one record ──
    // 1 Created entry + (DEEP_AUDIT_COUNT - 1) Updated entries = DEEP_AUDIT_COUNT total.
    const record: E2eTestRecord = {
      id: newRecordId('perf-deep-audit'),
      clientId: 'a',
      value: 'v0',
    };
    await a.upsert(record);
    for (let i = 1; i < DEEP_AUDIT_COUNT; i++) {
      await a.upsert({ ...record, value: `v${i}` });
    }

    // Drain the C2S queue — all DEEP_AUDIT_COUNT entries must be on the server
    // before we start timing, so the measured update hits a full audit history.
    await waitForAllClientsIdle([a]);
    await useServer().waitForLiveRecord(record.id, { timeoutMs: 60_000 });

    // ── Timed window: one more update against the deep audit history ──
    const start = Date.now();
    await a.upsert({ ...record, value: 'final' });
    await waitForAllClientsIdle([a]);
    const elapsed = Date.now() - start;

    expect(
      elapsed,
      `update on record with ${DEEP_AUDIT_COUNT} audit entries took ${elapsed}ms, budget ${THRESHOLDS.deepAuditUpdateMs}ms`,
    ).toBeLessThan(THRESHOLDS.deepAuditUpdateMs);
  }, 120_000);
});
