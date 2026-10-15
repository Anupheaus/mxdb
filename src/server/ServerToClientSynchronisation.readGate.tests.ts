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

interface CreateClientOptions {
  beforeEachRead?(): void;
  isGated?: boolean;
  /** False when the client's database does not register the collection: the gated read then answers nothing for it. */
  isCollectionKnown?: boolean;
}

/** A client of the given gate, holding nothing yet. `beforeEachRead` runs as the server touches the database. */
function createClient(isReadable?: ReadGate, { beforeEachRead = () => undefined, isGated = true, isCollectionKnown = true }: CreateClientOptions = {}) {
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
    if (!isCollectionKnown) return [];
    return request.map(({ collectionName, recordIds }) => ({ collectionName, records: readStored(recordIds).filter(isReadable), isGated }));
  };
  const gateRequests: MXDBRecordStatesRequest[] = [];
  const recordedReadReadable = readReadable == null ? undefined : (request: MXDBRecordStatesRequest) => {
    gateRequests.push(structuredClone(request));
    return readReadable(request);
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
    readReadable: recordedReadReadable,
  });
  const store = (record: Widget, sequence: number): Widget => {
    records.set(record.id, record);
    audits.set(record.id, { id: record.id, entries: [createdEntry(record, sequence)] } as AuditOf<Widget>);
    return record;
  };
  return { s2c, emitted, store, records, gateRequests };
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

  it('pushes nothing and evicts nothing for a collection the gated read does not know (sc-999)', async () => {
    readable.clear(); readable.add('a');
    const { s2c, emitted, store } = createClient(gate, { isCollectionKnown: false });
    await s2c.pushActive(COLLECTION, [store({ id: 'a', name: 'A' }, 1)]);
    await settle();
    expect(delivered(emitted)).toEqual({ pushed: ['a'], evicted: [] });
    emitted.length = 0;

    await s2c.onDbChange({ type: 'upsert', collectionName: COLLECTION, records: [store({ id: 'a', name: 'A2' }, 2)] });
    await settle();
    expect(emitted).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unknown collection'), expect.objectContaining({ collectionName: COLLECTION }));
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

  describe('gate cost: only changed records the socket holds are gate-checked (sc-997)', () => {
    const SOCKET_COUNT = 3;
    type Socket = ReturnType<typeof createClient>;
    const createSockets = (): Socket[] => Array.from({ length: SOCKET_COUNT }, () => createClient(gate));
    /** One socket that will hold the record, and the other connected sockets. */
    const createHolderAndOthers = (): { holder: Socket; others: Socket[]; sockets: Socket[] } => {
      const holder = createClient(gate);
      const others = Array.from({ length: SOCKET_COUNT - 1 }, () => createClient(gate));
      return { holder, others, sockets: [holder, ...others] };
    };
    const gateCallCount = (sockets: Socket[]) => sockets.reduce((count, { gateRequests }) => count + gateRequests.length, 0);

    /** The same write lands in every socket's (stubbed) database and its change-stream event reaches every socket. */
    async function changeOnEverySocket(sockets: Socket[], changed: Widget[], sequence: number): Promise<void> {
      await sockets.mapAsync(async ({ s2c, store }) => {
        await s2c.onDbChange({ type: 'upsert', collectionName: COLLECTION, records: changed.map(record => store(record, sequence)) });
      });
      await settle();
    }

    async function holdOn(socket: Socket, record: Widget): Promise<void> {
      await socket.s2c.pushActive(COLLECTION, [socket.store(record, 1)]);
      await settle();
      socket.emitted.length = 0;
    }

    it('makes no gate call for a change to a record that no connected socket holds', async () => {
      readable.clear(); readable.add('a');
      const sockets = createSockets();
      await changeOnEverySocket(sockets, [{ id: 'a', name: 'A' }], 1);
      expect(gateCallCount(sockets)).toBe(0);
      expect(sockets.flatMap(({ emitted }) => emitted)).toEqual([]);
    });

    it('makes one gate call, on the holding socket only, for a change to a record one socket holds', async () => {
      readable.clear(); readable.add('a');
      const { holder, others, sockets } = createHolderAndOthers();
      await holdOn(holder, { id: 'a', name: 'A' });

      await changeOnEverySocket(sockets, [{ id: 'a', name: 'A2' }], 2);
      expect(holder.gateRequests).toEqual([[{ collectionName: COLLECTION, recordIds: ['a'] }]]);
      expect(gateCallCount(others)).toBe(0);
    });

    it('gate-checks only the held ids of a batch that mixes held and unheld records', async () => {
      readable.clear(); readable.add('a'); readable.add('b');
      const socket = createClient(gate);
      await holdOn(socket, { id: 'a', name: 'A' });

      await changeOnEverySocket([socket], [{ id: 'a', name: 'A2' }, { id: 'b', name: 'B' }], 2);
      expect(socket.gateRequests).toEqual([[{ collectionName: COLLECTION, recordIds: ['a'] }]]);
      expect(delivered(socket.emitted)).toEqual({ pushed: ['a'], evicted: [] });
    });

    it('still pushes a readable change and evicts a reassigned record on the socket that holds it, and nothing elsewhere', async () => {
      readable.clear(); readable.add('a');
      const { holder, others, sockets } = createHolderAndOthers();
      await holdOn(holder, { id: 'a', name: 'A' });

      await changeOnEverySocket(sockets, [{ id: 'a', name: 'A2' }], 2);
      expect(delivered(holder.emitted)).toEqual({ pushed: ['a'], evicted: [] });
      holder.emitted.length = 0;

      readable.delete('a');
      await changeOnEverySocket(sockets, [{ id: 'a', name: 'reassigned' }], 3);
      expect(delivered(holder.emitted)).toEqual({ pushed: [], evicted: ['a'] });
      expect(others.flatMap(({ emitted }) => emitted)).toEqual([]);
    });

    it('gate-checks a change that lands while an authoritative push of the record is still being built', async () => {
      readable.clear(); readable.add('a');
      let pendingChange: Promise<void> | undefined;
      let landChange: (() => void) | undefined;
      const socket = createClient(gate, { beforeEachRead: () => { const landNow = landChange; landChange = undefined; landNow?.(); } });
      const original = socket.store({ id: 'a', name: 'A' }, 1);
      landChange = () => {
        pendingChange = socket.s2c.onDbChange({ type: 'upsert', collectionName: COLLECTION, records: [socket.store({ id: 'a', name: 'A2' }, 2)] });
      };
      await socket.s2c.pushActive(COLLECTION, [original]);
      await pendingChange;
      await settle();
      expect(socket.gateRequests).toEqual([[{ collectionName: COLLECTION, recordIds: ['a'] }]]);
    });
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
