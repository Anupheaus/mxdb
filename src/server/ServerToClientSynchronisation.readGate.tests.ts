import { describe, it, expect, vi } from 'vitest';
import '@anupheaus/common'; // installs array extensions (.ids()) and Object.clone used by the sync engine
import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import { AuditEntryType, defineCollection } from '../common';
import type { AuditEntry, AuditOf } from '../common/auditor';
import type { MXDBReadableRecords, MXDBRecordCursors, MXDBRecordStatesRequest, MXDBSyncEngineResponse } from '../common/sync-engine';
import { ServerToClientSynchronisation } from './ServerToClientSynchronisation';
import type { ServerDb } from './providers/db/ServerDb';

/**
 * Change-stream fan-out applies the client's read gate (sc-584). A record the client holds that has left its gate — a
 * reassigned task, a capability taken away — is not pushed again but EVICTED from the client; a record it never held
 * and may not read is not sent at all. The content is read THROUGH the gate in one query, so a record is never judged on
 * one version and sent as another (sc-682). `emitS2C` (the client) and the database are stubbed; the real dispatcher runs.
 */

interface Widget extends MXDBRecord {
  name: string;
}

const COLLECTION = 's2cGatedWidgets';
const collection = defineCollection<Widget>({ name: COLLECTION, indexes: [] });
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn(), createSubLogger: vi.fn() };
logger.createSubLogger.mockReturnValue(logger);

const createdEntry = (record: Widget, sequence: number): AuditEntry<Widget> =>
  ({ type: AuditEntryType.Created, id: `01J${String(sequence).padStart(23, '0')}`, record: { ...record } }) as AuditEntry<Widget>;

/** Which stored records the client may read, judged on what is stored when the gate is asked. */
type ReadGate = (record: Widget) => boolean;
type StoredRecords = Map<string, Widget>;

/** A client of the given gate, holding nothing yet. `beforeEachRead` runs as the server touches the database. */
function createClient(isReadable?: ReadGate, { beforeEachRead = () => undefined, isGated = true }: { beforeEachRead?(): void; isGated?: boolean } = {}) {
  const records: StoredRecords = new Map<string, Widget>();
  const audits = new Map<string, AuditOf<Widget>>();
  const readStored = (ids: string[]) => ids.map(id => records.get(id)).filter((record): record is Widget => record != null);
  const dbCollection = {
    get: async (ids: string[]) => { beforeEachRead(); return readStored(ids); },
    getAudit: async (ids: string | string[]) => {
      beforeEachRead();
      return Array.isArray(ids) ? ids.map(id => audits.get(id)).filter(audit => audit != null) : audits.get(ids);
    },
  };
  // One query: the gate decision and the content come from the same stored version.
  const readReadable = isReadable == null ? undefined : async (request: MXDBRecordStatesRequest): Promise<MXDBReadableRecords> => {
    beforeEachRead();
    return request.map(({ collectionName, recordIds }) => ({ collectionName, records: readStored(recordIds).filter(isReadable), isGated }));
  };
  const emitted: MXDBRecordCursors[] = [];
  const s2c = new ServerToClientSynchronisation({
    emitS2C: async (payload): Promise<MXDBSyncEngineResponse> => {
      emitted.push(structuredClone(payload));
      return payload.map(({ collectionName, records: cursors }) => ({
        collectionName, successfulRecordIds: cursors.map(cursor => ('record' in cursor ? cursor.record.id : cursor.recordId)),
      }));
    },
    getDb: () => ({ use: () => dbCollection }) as unknown as ServerDb,
    collections: [collection],
    logger: logger as unknown as Logger,
    readReadable,
  });
  const store = (record: Widget, sequence: number): Widget => {
    records.set(record.id, record);
    audits.set(record.id, { id: record.id, entries: [createdEntry(record, sequence)] } as AuditOf<Widget>);
    return record;
  };
  return { s2c, emitted, store, records };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 50; tick++) await Promise.resolve();
}

/** What reached the client: record ids pushed with content, and ids evicted. */
function delivered(emitted: MXDBRecordCursors[]): { pushed: string[]; evicted: string[] } {
  const cursors = emitted.flatMap(payload => payload.flatMap(({ records }) => records));
  return {
    pushed: cursors.flatMap(cursor => ('record' in cursor ? [cursor.record.id] : [])),
    evicted: cursors.flatMap(cursor => (!('record' in cursor) && cursor.isEviction === true ? [cursor.recordId] : [])),
  };
}

describe('ServerToClientSynchronisation — change-stream fan-out through the read gate', () => {
  const readable = new Set<string>();
  const gate: ReadGate = ({ id }) => readable.has(id);

  it('pushes a change to a record the client holds and may read', async () => {
    readable.clear(); readable.add('a');
    const { s2c, emitted, store } = createClient(gate);
    await s2c.pushActive(COLLECTION, [store({ id: 'a', name: 'A' }, 1)]);
    await settle();
    emitted.length = 0;

    await s2c.onDbChange({ type: 'upsert', collectionName: COLLECTION, records: [store({ id: 'a', name: 'A2' }, 2)] });
    await settle();
    expect(delivered(emitted)).toEqual({ pushed: ['a'], evicted: [] });
  });

  it('evicts a record the client holds once it leaves the gate, and pushes none of it', async () => {
    readable.clear(); readable.add('a');
    const { s2c, emitted, store } = createClient(gate);
    await s2c.pushActive(COLLECTION, [store({ id: 'a', name: 'A' }, 1)]);
    await settle();
    emitted.length = 0;

    readable.delete('a');
    await s2c.onDbChange({ type: 'upsert', collectionName: COLLECTION, records: [store({ id: 'a', name: 'reassigned' }, 2)] });
    await settle();
    expect(delivered(emitted)).toEqual({ pushed: [], evicted: ['a'] });
  });

  it('sends nothing for a record the client never held and may not read', async () => {
    readable.clear();
    const { s2c, emitted, store } = createClient(gate);
    await s2c.onDbChange({ type: 'upsert', collectionName: COLLECTION, records: [store({ id: 'b', name: 'B' }, 1)] });
    await settle();
    expect(emitted).toEqual([]);
  });

  it('pushes nothing and evicts nothing when the gate itself fails', async () => {
    readable.clear(); readable.add('a');
    let isGateBroken = false;
    const { s2c, emitted, store } = createClient(record => {
      if (isGateBroken) throw new Error('gate lookup failed');
      return gate(record);
    });
    await s2c.pushActive(COLLECTION, [store({ id: 'a', name: 'A' }, 1)]);
    await settle();
    emitted.length = 0;

    isGateBroken = true;
    await s2c.onDbChange({ type: 'upsert', collectionName: COLLECTION, records: [store({ id: 'a', name: 'A2' }, 2)] });
    await settle();
    expect(emitted).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('read gate failed'), expect.objectContaining({ collectionName: COLLECTION }));
  });

  it('pushes every change when there is no gate (unchanged behaviour)', async () => {
    const { s2c, emitted, store } = createClient();
    await s2c.pushActive(COLLECTION, [store({ id: 'a', name: 'A' }, 1)]);
    await settle();
    emitted.length = 0;

    await s2c.onDbChange({ type: 'upsert', collectionName: COLLECTION, records: [store({ id: 'a', name: 'A2' }, 2)] });
    await settle();
    expect(delivered(emitted)).toEqual({ pushed: ['a'], evicted: [] });
  });

  it('does not evict a record when the collection has no gate and simply no longer stores it', async () => {
    const { s2c, emitted, store, records } = createClient(() => true, { isGated: false });
    const held = store({ id: 'a', name: 'A' }, 1);
    await s2c.pushActive(COLLECTION, [held]);
    await settle();
    emitted.length = 0;

    records.delete('a');
    await s2c.onDbChange({ type: 'upsert', collectionName: COLLECTION, records: [held] });
    await settle();
    expect(emitted).toEqual([]);
  });

  describe('two close changes: readable, then reassigned away (sc-682)', () => {
    interface OwnedWidget extends Widget { ownerId: string; }
    const isMine: ReadGate = record => (record as OwnedWidget).ownerId === 'me';

    it('never sends the reassigned content, and evicts the record', async () => {
      let landSecondChange: (() => void) | undefined;
      let readsSinceArmed = 0;
      // Change 2 lands just after the server's first database read for change 1 — after a gate check made apart from
      // the content read, and before that content read.
      const { s2c, emitted, store } = createClient(isMine, {
        beforeEachRead: () => {
          if (landSecondChange == null || ++readsSinceArmed < 2) return;
          landSecondChange();
          landSecondChange = undefined;
        },
      });
      await s2c.pushActive(COLLECTION, [store({ id: 'x', name: 'mine', ownerId: 'me' } as OwnedWidget, 1)]);
      await settle();
      emitted.length = 0;

      // Change 1 is still readable; change 2 reassigns X away.
      const secondChange = { id: 'x', name: 'reassigned', ownerId: 'someone-else' } as OwnedWidget;
      landSecondChange = () => { store(secondChange, 3); };
      await s2c.onDbChange({ type: 'upsert', collectionName: COLLECTION, records: [store({ id: 'x', name: 'mine v2', ownerId: 'me' } as OwnedWidget, 2)] });
      await settle();
      // Change 2's own event arrives after change 1's push has gone out.
      await s2c.onDbChange({ type: 'upsert', collectionName: COLLECTION, records: [secondChange] });
      await settle();

      const sentNames = emitted.flatMap(payload => payload.flatMap(({ records }) => records)).flatMap(cursor => ('record' in cursor ? [(cursor.record as Widget).name] : []));
      expect({ sentNames, evicted: delivered(emitted).evicted.distinct() }).toEqual({ sentNames: [], evicted: ['x'] });
    });
  });
});
