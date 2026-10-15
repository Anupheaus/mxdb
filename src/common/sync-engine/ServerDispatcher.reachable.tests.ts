import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '@anupheaus/common';
import { ServerDispatcher } from './ServerDispatcher';
import type { MXDBActiveRecordCursor, MXDBDeletedRecordCursor, MXDBRecordCursors, MXDBSyncEngineResponse } from './models';

/**
 * `reachableRecordIds` tells the change-stream path which changed ids a change-stream push could still reach this client
 * for, so per-client work (the read gate) is skipped for records it does not hold (sc-997). It must agree with what
 * dispatch does: ids in the filter, plus ids an authoritative push is still delivering (they join the filter on ack).
 */

const COLLECTION = 'items';
const OTHER_COLLECTION = 'others';
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() } as unknown as Logger;

const active = (id: string, collectionName = COLLECTION): MXDBRecordCursors =>
  [{ collectionName, records: [{ record: { id }, lastAuditEntryId: 'u1', hash: `hash-${id}` } as MXDBActiveRecordCursor] }];
const removed = (recordId: string): MXDBRecordCursors => [{ collectionName: COLLECTION, records: [{ recordId, lastAuditEntryId: 'u1' } as MXDBDeletedRecordCursor] }];

interface DispatcherHarness {
  sd: ServerDispatcher;
  /** Resolves the dispatch the client is answering, acknowledging everything in it. */
  answer(): void;
}

/** A dispatcher whose client answers each dispatch only when told to, so a push can be held in flight. */
function makeDispatcher(): DispatcherHarness {
  let pendingAnswer: (() => void) | undefined;
  const sd = new ServerDispatcher(logger, {
    onDispatch: (payload: MXDBRecordCursors): Promise<MXDBSyncEngineResponse> => new Promise(resolve => {
      pendingAnswer = () => resolve(payload.map(({ collectionName, records }) => ({
        collectionName, successfulRecordIds: records.map(cursor => ('record' in cursor ? cursor.record.id : cursor.recordId)),
      })));
    }),
  });
  return { sd, answer: () => { const answerNow = pendingAnswer; pendingAnswer = undefined; answerNow?.(); } };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}

describe('ServerDispatcher.reachableRecordIds', () => {
  it('returns nothing for a client that holds nothing', () => {
    const { sd } = makeDispatcher();
    expect(sd.reachableRecordIds(COLLECTION, ['a', 'b'])).toEqual([]);
  });

  it('returns only the ids the client holds, in the order asked', async () => {
    const { sd, answer } = makeDispatcher();
    sd.push(active('b'));
    await settle();
    answer();
    await settle();
    expect(sd.reachableRecordIds(COLLECTION, ['a', 'b', 'c'])).toEqual(['b']);
  });

  it('counts an id whose authoritative push is still in flight, which joins the filter on ack', async () => {
    const { sd } = makeDispatcher();
    sd.push(active('a'));
    await settle();
    expect(sd.reachableRecordIds(COLLECTION, ['a'])).toEqual(['a']);
  });

  it('does not count an id that is only queued in a change-stream push (it cannot bootstrap the record)', () => {
    const { sd } = makeDispatcher();
    sd.pause();
    sd.push(active('a'), false);
    expect(sd.reachableRecordIds(COLLECTION, ['a'])).toEqual([]);
  });

  it('does not count an id the client holds in another collection', async () => {
    const { sd, answer } = makeDispatcher();
    sd.push(active('a', OTHER_COLLECTION));
    await settle();
    answer();
    await settle();
    expect(sd.reachableRecordIds(COLLECTION, ['a'])).toEqual([]);
  });

  it('stops counting a record once the client has acknowledged its delete', async () => {
    const { sd, answer } = makeDispatcher();
    sd.push(active('a'));
    await settle();
    answer();
    await settle();
    sd.push(removed('a'), false);
    await settle();
    answer();
    await settle();
    expect(sd.reachableRecordIds(COLLECTION, ['a'])).toEqual([]);
  });
});
