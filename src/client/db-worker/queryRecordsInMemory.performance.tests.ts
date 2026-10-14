// @vitest-environment node
// Vision sc-2518 QA round 6: the device's one filter evaluator must stay at least as fast as master's in-memory fast
// path (sift over date-normalised copies of each record), which every `useX.query(ids)` used to take. Each case runs
// both, interleaved, and compares medians; a generous bound (1.5x) keeps a busy CI runner from failing it by noise,
// while a per-record cost such as re-reading a long `$in` list for every record fails it by a wide margin.
import { describe, expect, it } from 'vitest';
import sift from 'sift';
import { DateTime } from 'luxon';
import type { DataFilters, Record } from '@anupheaus/common';
import { queryRecordsInMemory } from './queryRecordsInMemory';

interface BenchRecord extends Record {
  name: string;
  value: number;
  tags: string[];
  when: DateTime;
}

const RECORD_COUNT = 20_000;
const RUNS = 7;
/** How much slower than master's fast path the evaluator may be before the test fails. */
const ALLOWED_RATIO = 1.5;
/** Below this many milliseconds a median is timer noise, not a cost worth comparing. */
const NOISE_FLOOR_MS = 5;
/** How much slower than a bare Set lookup per record a large `$in` may be (it still walks the path and sorts). */
const LARGE_LIST_RATIO = 25;
/**
 * A large `$in` on 20,000 records within this many milliseconds passes whatever the ratio (timer and GC noise on a
 * busy runner). Master's sift path took about 12 s for 2,000 ids, and QA round 6's regression about 1.5 s.
 */
const LARGE_LIST_CEILING_MS = 100;

const START = DateTime.fromISO('2026-01-01T00:00:00Z');

const RECORDS: BenchRecord[] = Array.from({ length: RECORD_COUNT }, (_, index) => ({
  id: `record-${index}`, name: `Name ${index % 977}`, value: index % 1_000, tags: [`t${index % 7}`, `t${index % 11}`], when: START.plus({ minutes: index }),
}));

const idsEvery = (step: number, count: number) => Array.from({ length: count }, (_, index) => `record-${(index * step) % RECORD_COUNT}`);

/** Master's in-memory fast path: sift, over a copy of each record with its DateTimes turned into Dates. */
function normaliseDates(value: unknown): unknown {
  if (DateTime.isDateTime(value)) return value.toJSDate();
  if (value == null || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(normaliseDates);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normaliseDates(nested)]));
  return value;
}

function viaMaster(siftQuery: object): number {
  const matches = sift(siftQuery as never) as (item: unknown) => boolean;
  return RECORDS.filter(record => matches(normaliseDates(record))).length;
}

function viaEvaluator(filters: DataFilters<BenchRecord>): number {
  return queryRecordsInMemory(RECORDS, { filters }).records.length;
}

function median(times: number[]): number {
  const ordered = [...times].sort((first, second) => first - second);
  return ordered[Math.floor(ordered.length / 2)]!;
}

function time(run: () => number): { milliseconds: number; count: number } {
  const started = performance.now();
  const count = run();
  return { milliseconds: performance.now() - started, count };
}

interface BenchCase {
  filters: DataFilters<BenchRecord>;
  /** The same query as master's fast path gave it to sift (DateTimes as Dates). */
  siftQuery: object;
}

const at = (minutes: number) => START.plus({ minutes });

const CASES: [string, BenchCase][] = [
  ['$in of 50 ids', { filters: { id: { $in: idsEvery(397, 50) } }, siftQuery: { id: { $in: idsEvery(397, 50) } } }],
  ['$in of 300 ids', { filters: { id: { $in: idsEvery(61, 300) } }, siftQuery: { id: { $in: idsEvery(61, 300) } } }],
  ['equality', { filters: { name: 'Name 5' }, siftQuery: { name: 'Name 5' } }],
  ['a date range', { filters: { when: { $gte: at(5_000), $lt: at(9_000) } }, siftQuery: { when: { $gte: at(5_000).toJSDate(), $lt: at(9_000).toJSDate() } } }],
  ['$in on a list field with a bound', {
    filters: { tags: { $in: ['t3', 't5'] }, value: { $lt: 500 } },
    siftQuery: { tags: { $in: ['t3', 't5'] }, value: { $lt: 500 } },
  }],
];

describe(`the device's filter evaluator against master's fast path, on ${RECORD_COUNT} records`, () => {
  it.each(CASES)('%s: the same records, and no slower than 1.5x', (_label, { filters, siftQuery }) => {
    const evaluatorTimes: number[] = [];
    const masterTimes: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const evaluator = time(() => viaEvaluator(filters));
      const master = time(() => viaMaster(siftQuery));
      expect(evaluator.count).toBe(master.count);
      evaluatorTimes.push(evaluator.milliseconds);
      masterTimes.push(master.milliseconds);
    }
    const [evaluatorMedian, masterMedian] = [median(evaluatorTimes), median(masterTimes)];
    expect({ evaluatorMedian, masterMedian, isWithinBound: evaluatorMedian <= Math.max(masterMedian * ALLOWED_RATIO, NOISE_FLOOR_MS) })
      .toMatchObject({ isWithinBound: true });
  }, 60_000);

  // Master's sift path reads a whole `$in` list for every record (about 12 s for 2,000 ids here), far too slow to run
  // as a baseline in CI. A large list is held instead to the cost of a plain Set lookup per record — the floor for any
  // evaluator — within LARGE_LIST_RATIO, so a per-record cost proportional to the list fails it.
  it.each([[2_000, 7], [10_000, 3]])('$in of %i ids: the same records as a Set lookup, at a comparable cost', (count, step) => {
    const ids = idsEvery(step, count);
    const evaluatorTimes: number[] = [];
    const floorTimes: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const evaluator = time(() => viaEvaluator({ id: { $in: ids } }));
      const floor = time(() => {
        const wanted = new Set(ids);
        return RECORDS.filter(({ id }) => wanted.has(id)).length;
      });
      expect(evaluator.count).toBe(floor.count);
      evaluatorTimes.push(evaluator.milliseconds);
      floorTimes.push(floor.milliseconds);
    }
    const [evaluatorMedian, floorMedian] = [median(evaluatorTimes), median(floorTimes)];
    expect({ evaluatorMedian, floorMedian, isWithinBound: evaluatorMedian <= Math.max(floorMedian * LARGE_LIST_RATIO, LARGE_LIST_CEILING_MS) })
      .toMatchObject({ isWithinBound: true });
  }, 60_000);
});
