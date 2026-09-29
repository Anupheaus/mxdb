import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@anupheaus/common';
import { to, type Logger } from '@anupheaus/common';
import { auditor } from '../auditor';

vi.mock('../auditor/hash', () => ({
  hashRecord: (record: { id: string }) => Promise.resolve(`mock-hash-${record.id}`),
}));
import {
  ClientDispatcher,
  ClientReceiver,
  type ClientDispatcherRequest,
  type MXDBRecordStates,
  type MXDBRecordStatesRequest,
  type MXDBSyncEngineResponse,
  type MXDBUpdateRequest,
} from '.';
import { MAX_DISPATCH_BYTES, MAX_RECORD_DISPATCH_BYTES, batchDispatchRecords, estimateDispatchBytes, type DispatchRecord } from './dispatchBatches';

/**
 * sc-623 — a large backlog of local changes must reach the server in emits small enough for the socket (nexus closes a
 * socket whose message passes 10 MB, and the same payload would then be retried forever, so nothing on the device would
 * sync again). Each record goes whole into one emit; one too big to ever get through is refused locally and never
 * blocks the others.
 */

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() } as unknown as Logger;
const TIMER_INTERVAL_MS = 100;
const SOCKET_LIMIT_BYTES = 10 * 1024 * 1024;

/** A record carrying `bytes` of text, so its dispatch is about that big. */
const recordOf = (id: string, bytes: number) => ({ id, body: 'x'.repeat(bytes) });

/** A record carrying `bytes` of quotes — each costs four bytes on the wire, once nexus and socket.io have both encoded it. */
const quotesRecordOf = (id: string, bytes: number) => ({ id, body: '"'.repeat(bytes) });

/**
 * What an emit really costs on the socket: nexus sends `to.serialise(request)` (a JSON string) and socket.io's parser
 * JSON-encodes it again — measured here with the real encoders, not with the estimator under test.
 */
const wireBytes = (request: ClientDispatcherRequest): number => new TextEncoder().encode(JSON.stringify(to.serialise(request))).length;

type DispatchOutcome = (request: ClientDispatcherRequest) => Promise<MXDBSyncEngineResponse>;
const acknowledgeAll: DispatchOutcome = async request => request.map(({ collectionName, records }) => ({ collectionName, successfulRecordIds: records.map(record => record.id) }));

interface Harness {
  cd: ClientDispatcher;
  dispatches: ClientDispatcherRequest[];
  updated: string[];
  onStalled: ReturnType<typeof vi.fn>;
  onTooLarge: ReturnType<typeof vi.fn>;
  setOutcome(outcome: DispatchOutcome): void;
}

async function startHarness({ records, startUpIds = [] as string[], limits = {} as { maxDispatchBytes?: number; maxRecordDispatchBytes?: number }, startUpOutcome }: {
  records: Record<string, { id: string; body: string }>;
  startUpIds?: string[];
  limits?: { maxDispatchBytes?: number; maxRecordDispatchBytes?: number };
  startUpOutcome?: DispatchOutcome;
}): Promise<Harness> {
  const stateOf = (id: string) => ({ record: records[id]!, audit: auditor.createAuditFrom(records[id]!).entries });
  const statesFor = (request: MXDBRecordStatesRequest): MXDBRecordStates => request.map(({ collectionName, recordIds }) => ({ collectionName, records: recordIds.map(stateOf) }));
  const clientReceiver = new ClientReceiver(logger, { onRetrieve: vi.fn().mockReturnValue([]), onUpdate: vi.fn().mockReturnValue([]) });
  const dispatches: ClientDispatcherRequest[] = [];
  const updated: string[] = [];
  let outcome = startUpOutcome ?? acknowledgeAll;
  const onStalled = vi.fn();
  const onTooLarge = vi.fn();
  const cd = new ClientDispatcher(logger, {
    clientReceiver,
    onPayloadRequest: statesFor as never,
    onDispatching: vi.fn(),
    onDispatch: async request => { dispatches.push(request); return outcome(request); },
    onUpdate: (updates: MXDBUpdateRequest) => { updated.push(...updates.flatMap(({ records: synced = [] }) => synced.map(({ record }) => record.id))); },
    onStart: vi.fn().mockImplementation(() => (startUpIds.length === 0 ? [] : statesFor([{ collectionName: 'photos', recordIds: startUpIds }]))),
    onStalled,
    onTooLarge,
    timerInterval: TIMER_INTERVAL_MS,
    ...limits,
  });
  cd.start();
  await vi.advanceTimersByTimeAsync(0);
  return { cd, dispatches, updated, onStalled, onTooLarge, setOutcome: next => { outcome = next; } };
}

const idsIn = (request: ClientDispatcherRequest) => request.flatMap(({ records }) => records.map(({ id }) => id));

describe('ClientDispatcher — dispatching a large backlog in socket-sized emits (sc-623)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('syncs more than 10 MB of queued changes in several emits, none of them near the socket limit', async () => {
    const ids = Array.from({ length: 48 }, (_, index) => `photo-${index}`);
    const records = Object.fromEntries(ids.map(id => [id, recordOf(id, 256 * 1024)]));
    const harness = await startHarness({ records });

    for (const id of ids) harness.cd.enqueue({ collectionName: 'photos', recordId: id });
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS * 2);

    const sizes = harness.dispatches.map(wireBytes);
    expect(sizes.reduce((total, size) => total + size, 0)).toBeGreaterThan(SOCKET_LIMIT_BYTES);
    expect(harness.dispatches.length).toBeGreaterThan(2);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_DISPATCH_BYTES + 1024);
    expect(harness.updated.sort()).toEqual([...ids].sort());
  });

  it('still sends the (empty) start-up dispatch when nothing is pending', async () => {
    const harness = await startHarness({ records: {} });
    expect(harness.dispatches).toEqual([[]]);
  });

  it('sends a start-up backlog of more than 10 MB in several emits too', async () => {
    const ids = Array.from({ length: 48 }, (_, index) => `photo-${index}`);
    const records = Object.fromEntries(ids.map(id => [id, recordOf(id, 256 * 1024)]));
    const harness = await startHarness({ records, startUpIds: ids });

    expect(harness.dispatches.length).toBeGreaterThan(2);
    expect(Math.max(...harness.dispatches.map(wireBytes))).toBeLessThanOrEqual(MAX_DISPATCH_BYTES + 1024);
    expect(harness.updated.sort()).toEqual([...ids].sort());
  });

  it('refuses a record too big to ever send — reported, never dispatched — and syncs the others', async () => {
    const records = { small1: recordOf('small1', 100), huge: recordOf('huge', 20_000), small2: recordOf('small2', 100) };
    const harness = await startHarness({ records, limits: { maxDispatchBytes: 2_000, maxRecordDispatchBytes: 10_000 } });

    for (const id of Object.keys(records)) harness.cd.enqueue({ collectionName: 'photos', recordId: id });
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS * 5);

    expect(harness.dispatches.flatMap(idsIn)).not.toContain('huge');
    expect(harness.updated.sort()).toEqual(['small1', 'small2']);
    expect(harness.onTooLarge.mock.calls).toEqual([[{ collectionName: 'photos', recordId: 'huge', bytes: expect.any(Number), limitBytes: 10_000 }]]);
    expect(harness.onStalled).not.toHaveBeenCalled();
    // Off the queue: nothing keeps trying (or blocking) on it
    const dispatchCount = harness.dispatches.length;
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS * 20);
    expect(harness.dispatches.length).toBe(dispatchCount);
  });

  it('counts the double encoding: an escape-heavy record that looks under the limit but is not on the wire is refused', async () => {
    // 3 MB of quotes: about 6 MB serialised once, about 12 MB on the wire — past the socket's 10 MB
    const records = { quotes: quotesRecordOf('quotes', 3 * 1024 * 1024), plain: recordOf('plain', 100) };
    const harness = await startHarness({ records });

    for (const id of Object.keys(records)) harness.cd.enqueue({ collectionName: 'photos', recordId: id });
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS * 2);

    const whatWouldBeSent = [{ collectionName: 'photos', records: [{ id: 'quotes', hash: 'mock-hash-quotes', entries: auditor.createAuditFrom(records.quotes).entries }] }];
    expect(new TextEncoder().encode(JSON.stringify(whatWouldBeSent)).length).toBeLessThan(MAX_RECORD_DISPATCH_BYTES);
    expect(wireBytes(whatWouldBeSent)).toBeGreaterThan(SOCKET_LIMIT_BYTES);
    expect(harness.dispatches.flatMap(idsIn)).not.toContain('quotes');
    expect(harness.onTooLarge).toHaveBeenCalledWith(expect.objectContaining({ recordId: 'quotes' }));
    expect(harness.updated).toEqual(['plain']);
  });

  it('reports a too-large change once, not on every retry of the start-up sweep', async () => {
    const records = { huge: recordOf('huge', 20_000), small: recordOf('small', 100) };
    const failing: DispatchOutcome = async () => { throw new Error('network down'); };
    const harness = await startHarness({ records, startUpIds: ['huge', 'small'], limits: { maxDispatchBytes: 2_000, maxRecordDispatchBytes: 10_000 }, startUpOutcome: failing });
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS * 20);

    expect(harness.onTooLarge).toHaveBeenCalledTimes(1);
    expect(harness.dispatches.filter(request => idsIn(request).includes('small')).length).toBeGreaterThan(1);
  });

  it('sends nothing when every change due is too large (no empty emit)', async () => {
    const records = { huge: recordOf('huge', 20_000) };
    const harness = await startHarness({ records, limits: { maxDispatchBytes: 2_000, maxRecordDispatchBytes: 10_000 } });
    const before = harness.dispatches.length;

    harness.cd.enqueue({ collectionName: 'photos', recordId: 'huge' });
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS * 3);

    expect(harness.dispatches.length).toBe(before);
    expect(harness.onTooLarge).toHaveBeenCalledTimes(1);
  });

  it('never lets one emit that keeps failing in the start-up sweep starve the ones after it', async () => {
    const records = { bad: recordOf('bad', 800), a: recordOf('a', 800), b: recordOf('b', 800) };
    const failsOnBad: DispatchOutcome = async request => {
      if (idsIn(request).includes('bad')) throw new Error('the server cannot take this one');
      return acknowledgeAll(request);
    };
    const harness = await startHarness({ records, startUpIds: ['bad', 'a', 'b'], limits: { maxDispatchBytes: 1_500, maxRecordDispatchBytes: 10_000 }, startUpOutcome: failsOnBad });
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS * 3);

    expect(harness.updated.sort()).toEqual(['a', 'b']);
    // The start-up sweep is not repeated for the one that fails: it backs off on its own
    expect(harness.dispatches.filter(request => idsIn(request).includes('a'))).toHaveLength(1);
  });

  it('sends a record bigger than an emit — but small enough for the socket — in an emit of its own', async () => {
    const records = { a: recordOf('a', 100), big: recordOf('big', 5_000), b: recordOf('b', 100) };
    const harness = await startHarness({ records, limits: { maxDispatchBytes: 2_000, maxRecordDispatchBytes: 10_000 } });

    for (const id of Object.keys(records)) harness.cd.enqueue({ collectionName: 'photos', recordId: id });
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS * 2);

    expect(harness.dispatches.map(idsIn).filter(ids => ids.length > 0)).toEqual([['a'], ['big'], ['b']]);
    expect(harness.updated.sort()).toEqual(['a', 'b', 'big']);
  });

  it('backs off only the emit that failed: the ones before it are settled, the ones after it go on the next tick', async () => {
    const records = { a: recordOf('a', 800), b: recordOf('b', 800), c: recordOf('c', 800) };
    const harness = await startHarness({ records, limits: { maxDispatchBytes: 1_500, maxRecordDispatchBytes: 10_000 } });
    let calls = 0;
    harness.setOutcome(async request => {
      if (request.length > 0) calls += 1;
      if (calls === 2) throw new Error('network blip');
      return acknowledgeAll(request);
    });

    for (const id of Object.keys(records)) harness.cd.enqueue({ collectionName: 'photos', recordId: id });
    await vi.advanceTimersByTimeAsync(TIMER_INTERVAL_MS * 30);

    const sent = harness.dispatches.map(idsIn).filter(ids => ids.length > 0);
    // a was settled by the first emit; b failed and was retried; c was never held back by b's failure
    expect(sent.slice(0, 2)).toEqual([['a'], ['b']]);
    expect(sent.filter(ids => ids.includes('a'))).toHaveLength(1);
    expect(sent.filter(ids => ids.includes('c'))).toHaveLength(1);
    expect(sent.filter(ids => ids.includes('b'))).toHaveLength(2);
    expect(harness.updated.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('batchDispatchRecords', () => {
  const record = (id: string, bytes: number, collectionName = 'photos'): DispatchRecord => ({
    collectionName, bytes, state: { recordId: id, audit: [] }, entry: { id, entries: [] },
  });

  it('fills each emit up to the limit, in order, keeping each record whole and grouping by collection', () => {
    const { batches, oversize } = batchDispatchRecords(
      [record('a', 400), record('b', 400, 'notes'), record('c', 400), record('d', 100)],
      { maxBatchBytes: 1_000, maxRecordBytes: 5_000 },
    );
    expect(oversize).toEqual([]);
    expect(batches.map(({ request }) => request.map(({ collectionName, records }) => [collectionName, records.map(({ id }) => id)]))).toEqual([
      [['photos', ['a']], ['notes', ['b']]],
      [['photos', ['c', 'd']]],
    ]);
  });

  it('puts a record bigger than an emit on its own, and sets aside one bigger than the record limit', () => {
    const { batches, oversize } = batchDispatchRecords(
      [record('a', 100), record('big', 2_000), record('huge', 9_000), record('b', 100)],
      { maxBatchBytes: 1_000, maxRecordBytes: 5_000 },
    );
    expect(batches.map(({ request }) => request.flatMap(({ records }) => records.map(({ id }) => id)))).toEqual([['a'], ['big'], ['b']]);
    expect(oversize.map(({ entry }) => entry.id)).toEqual(['huge']);
  });

  it('measures UTF-8 bytes, not characters', () => {
    // serialised once: "é" (4 bytes); encoded again: "\"é\"" (8 bytes)
    expect(estimateDispatchBytes('é')).toBe(8);
    expect(estimateDispatchBytes({ note: 'a"b' })).toBe(new TextEncoder().encode(JSON.stringify(to.serialise({ note: 'a"b' }))).length);
  });
});
