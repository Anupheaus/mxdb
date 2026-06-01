import * as path from 'path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  setupE2E,
  teardownE2E,
  useClient,
  useRunLogger,
  type E2EClientHandle,
} from '../setup';
import {
  NUM_CLIENTS,
  E2E_STRESS_DELETE_ROLL_CHANCE,
  E2E_STRESS_MAX_RECORDS,
  TEST_DURATION_MS,
  SERVER_RESTART_AT_MS,
  STAGGER_CONNECT_MS,
} from './config';
import { clear as clearRecordsOfTruth } from './recordsOfTruth';
import { createStressFinalReporter } from './stressFinalReport';
import { runStressRandomMixWorkload } from './stressRandomMixWorkload';

describe('client sync integration', () => {
  let clients: E2EClientHandle[] = [];
  const { emitFinalReport } = createStressFinalReporter(() => clients);

  beforeAll(async () => {
    await setupE2E({
      runLoggerOptions: {
        logsDir: path.join(__dirname, 'logs'),
        prefix: 'stress',
      },
    });

    const runLogger = useRunLogger();
    runLogger.log('test_start', {
      numClients: NUM_CLIENTS,
      maxRecords: E2E_STRESS_MAX_RECORDS,
      maxDeletes: Math.floor(E2E_STRESS_MAX_RECORDS / 2),
      deleteRollChance: E2E_STRESS_DELETE_ROLL_CHANCE,
      workloadDurationMs: TEST_DURATION_MS,
      serverRestartAtMs: SERVER_RESTART_AT_MS,
      note: 'random create/update/delete until duration elapses, getAll on all clients; optional mid-workload server restart; no wait after delete (peers may still edit → restoration)',
    });

    clearRecordsOfTruth();

    clients = Array.from({ length: NUM_CLIENTS }, (_, i) => useClient(`${i}`));
    // Stagger connections over STAGGER_CONNECT_MS so clients don't all hit the
    // server at once — mirrors real-world staggered user arrivals.
    await Promise.all(clients.map(async (c, i) => {
      const delay = clients.length > 1
        ? Math.floor((i / (clients.length - 1)) * STAGGER_CONNECT_MS)
        : 0;
      await new Promise(r => setTimeout(r, delay));
      await c.connect();
    }));
  }, 90_000);

  afterAll(async () => {
    await emitFinalReport('afterAll');
    await teardownE2E();
  }, 60_000);

  it('runs clients with random create/update/delete (capped live rows + capped deletes), then asserts integrity', async () => {
    await runStressRandomMixWorkload({ clients, emitFinalReport });
  }, 300_000);
});
