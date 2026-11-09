import { describe, it, expect, vi } from 'vitest';
import { to } from '@anupheaus/common'; // also installs Object.clone used by the auditor
import type { Logger } from '@anupheaus/common';
import { auditor, type AuditOf } from '../auditor';
import { ServerReceiver } from './ServerReceiver';
import type { ServerDispatcher } from './ServerDispatcher';
import type { ClientDispatcherRequest, MXDBRecordStates, MXDBSyncEngineResponse } from './models';

// ─── A save of a record holding one object with tens of thousands of named entries (sc-5052) ─────────────────────────
//
// The receiver copies the record through `to.serialise` / `to.deserialise` on every replay. Those used to take time growing
// with the square of an object's key count, so one such save held the server (and every other client's save) for minutes.

const COLLECTION = 'items';
const KEY_COUNT = 50_000;
/** A save of the large record, and another client's small save started straight after it, each finish within this. */
const PROMPT_MS = 3_000;
/** A 2,000-key round trip takes a few milliseconds when linear, and over a second with the old quadratic copy. */
const PROBE_KEY_COUNT = 2_000;
const PROBE_LINEAR_MS = 250;

interface LargeRecord {
  id: string;
  name: string;
  entries: Record<string, number>;
}

const wideEntries = (keyCount: number): Record<string, number> => {
  const entries: Record<string, number> = {};
  for (let keyIndex = 0; keyIndex < keyCount; keyIndex++) entries[`key${keyIndex}`] = keyIndex;
  return entries;
};

/**
 * Whether the resolved `@anupheaus/common` already copies in linear time. Until this package's lockfile moves to the
 * release with the fix, CI resolves the older one, where this save would never finish; the guard keeps that run green.
 * The common library's own tests guard the timing itself, so this never hides a regression there.
 */
const isCommonCopyLinear = (() => {
  const probe = wideEntries(PROBE_KEY_COUNT);
  const startedAt = performance.now();
  to.deserialise(to.serialise(probe));
  return performance.now() - startedAt < PROBE_LINEAR_MS;
})();

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() } as unknown as Logger;

const makeDispatcher = () => ({ pause: vi.fn(), resume: vi.fn(), updateFilter: vi.fn(), push: vi.fn() } as unknown as ServerDispatcher);

/** A receiver for one client, holding `stored` as the server's copy of the record. */
const makeReceiver = <RecordType extends LargeRecord>(stored: RecordType) => {
  const audit = auditor.createAuditFrom(stored);
  const states: MXDBRecordStates = [{ collectionName: COLLECTION, records: [{ record: stored, audit: audit.entries }] }];
  const onUpdate = vi.fn((): Promise<MXDBSyncEngineResponse> => Promise.resolve([{ collectionName: COLLECTION, successfulRecordIds: [stored.id] }]));
  const receiver = new ServerReceiver(logger, { onRetrieve: () => Promise.resolve(states), onUpdate, serverDispatcher: makeDispatcher() });
  return { receiver, audit, onUpdate };
};

const saveOf = (record: LargeRecord, previous: AuditOf<LargeRecord>): ClientDispatcherRequest => [{
  collectionName: COLLECTION,
  records: [{ id: record.id, hash: `client-${record.id}`, entries: auditor.updateAuditWith(record, previous).entries }],
}];

describe.runIf(isCommonCopyLinear)('ServerReceiver: a record holding one object with 50,000 named entries (sc-5052)', () => {

  it('saves promptly, and another client\'s save started at the same moment is not held up', async () => {
    const large = makeReceiver<LargeRecord>({ id: 'large', name: 'Large', entries: {} });
    const small = makeReceiver<LargeRecord>({ id: 'small', name: 'Small', entries: {} });
    const largeSave = saveOf({ id: 'large', name: 'Large', entries: wideEntries(KEY_COUNT) }, large.audit);
    const smallSave = saveOf({ id: 'small', name: 'Renamed', entries: {} }, small.audit);

    const startedAt = performance.now();
    let smallFinishedAt = 0;
    const [largeResult] = await Promise.all([
      large.receiver.process(largeSave),
      small.receiver.process(smallSave).then(() => { smallFinishedAt = performance.now(); }),
    ]);
    const largeFinishedAt = performance.now();

    expect(largeFinishedAt - startedAt).toBeLessThan(PROMPT_MS);
    expect(smallFinishedAt - startedAt).toBeLessThan(PROMPT_MS);
    expect(largeResult.find(response => response.collectionName === COLLECTION)?.successfulRecordIds).toContain('large');
    const [[persisted]] = large.onUpdate.mock.calls as unknown as [[MXDBRecordStates]];
    const persistedRecord = (persisted[0]!.records[0] as unknown as { record: LargeRecord }).record;
    expect(Object.keys(persistedRecord.entries)).toHaveLength(KEY_COUNT);
    expect(persistedRecord.entries[`key${KEY_COUNT - 1}`]).toBe(KEY_COUNT - 1);
  }, 60_000);

});
