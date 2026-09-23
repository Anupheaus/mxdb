import { describe, it, expect, vi, afterEach } from 'vitest';
import '@anupheaus/common'; // installs Object.clone used by the auditor
import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import { auditor, AuditEntryType, type AuditEntry } from '../auditor';
import { ServerReceiver } from './ServerReceiver';
import type { ServerDispatcher } from './ServerDispatcher';
import type {
  ClientDispatcherRequest,
  MXDBRecordCursors,
  MXDBRecordMetas,
  MXDBRecordStates,
  MXDBSyncEngineResponse,
} from './models';
import type * as HashModule from '../auditor/hash';

vi.mock('../auditor/hash', async importOriginal => ({
  ...(await importOriginal<typeof HashModule>()),
  hashRecord: (record: MXDBRecord) => Promise.resolve(`hash-${record.id}`),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const COLLECTION = 'items';
const SLOW_PROCESS_MS = 2_500;

interface FakeDispatcher {
  serverDispatcher: ServerDispatcher;
  pushed: MXDBRecordCursors[];
}

function makeDispatcher(): FakeDispatcher {
  const pushed: MXDBRecordCursors[] = [];
  const serverDispatcher = {
    pause: vi.fn(),
    resume: vi.fn(),
    updateFilter: vi.fn(),
    push: vi.fn((payload: MXDBRecordCursors) => { pushed.push(payload); }),
  } as unknown as ServerDispatcher;
  return { serverDispatcher, pushed };
}

function makeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn>; } {
  const warn = vi.fn();
  const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), silly: vi.fn() } as unknown as Logger;
  return { logger, warn };
}

interface ReceiverSetup {
  onRetrieve?: () => Promise<MXDBRecordStates>;
  onRetrieveMeta?: () => Promise<MXDBRecordMetas>;
  onUpdate?: () => Promise<MXDBSyncEngineResponse>;
  logger?: Logger;
}

function makeReceiver({ onRetrieve, onRetrieveMeta, onUpdate, logger }: ReceiverSetup = {}) {
  const dispatcher = makeDispatcher();
  const retrieve = vi.fn(onRetrieve ?? (() => Promise.resolve([])));
  const update = vi.fn(onUpdate ?? (() => Promise.resolve([])));
  const receiver = new ServerReceiver(logger ?? makeLogger().logger, {
    onRetrieve: retrieve,
    onRetrieveMeta,
    onUpdate: update,
    serverDispatcher: dispatcher.serverDispatcher,
  });
  return { receiver, retrieve, update, ...dispatcher };
}

const branchOnly = (id: string, hash: string | undefined): ClientDispatcherRequest => [{
  collectionName: COLLECTION,
  records: [{ id, hash, entries: [{ type: AuditEntryType.Branched, id: '01BRANCH' }] }],
}];

function deletedServerState(recordId: string): { states: MXDBRecordStates; lastId: string; } {
  const audit = auditor.delete(auditor.createAuditFrom({ id: recordId, name: 'server' }));
  const lastId = audit.entries[audit.entries.length - 1]!.id;
  return { states: [{ collectionName: COLLECTION, records: [{ recordId, audit: audit.entries }] }], lastId };
}

function successIdsOf(response: MXDBSyncEngineResponse): string[] {
  return response.find(item => item.collectionName === COLLECTION)?.successfulRecordIds ?? [];
}

afterEach(() => {
  vi.useRealTimers();
});

// ─── Branched-only records against a tombstoned server record ─────────────────

describe('ServerReceiver with a branched-only record the server has deleted', () => {
  it('pushes a delete cursor at the server audit position when the client still holds the record', async () => {
    const { states, lastId } = deletedServerState('r1');
    const { receiver, pushed } = makeReceiver({ onRetrieve: () => Promise.resolve(states) });

    await receiver.process(branchOnly('r1', 'client-hash'));

    expect(pushed).toEqual([[{ collectionName: COLLECTION, records: [{ recordId: 'r1', lastAuditEntryId: lastId }] }]]);
  });

  it('pushes nothing when the client already knows the record is deleted', async () => {
    const { states } = deletedServerState('r1');
    const { receiver, pushed } = makeReceiver({ onRetrieve: () => Promise.resolve(states) });

    await receiver.process(branchOnly('r1', undefined));

    expect(pushed).toEqual([]);
  });

  it('acknowledges the record so the client can clear it from its queue', async () => {
    const { states } = deletedServerState('r1');
    const { receiver } = makeReceiver({ onRetrieve: () => Promise.resolve(states) });

    const response = await receiver.process(branchOnly('r1', 'client-hash'));

    expect(successIdsOf(response)).toEqual(['r1']);
  });
});

describe('ServerReceiver with a branched-only deletion the server has never seen', () => {
  it('pushes nothing because both sides agree the record does not exist', async () => {
    const { receiver, pushed } = makeReceiver();

    await receiver.process(branchOnly('ghost', undefined));

    expect(pushed).toEqual([]);
  });
});

// ─── Client deletions of records the server does not hold ─────────────────────

describe('ServerReceiver with a client deletion of a record the server does not hold', () => {
  const request: ClientDispatcherRequest = [{
    collectionName: COLLECTION,
    records: [{ id: 'lost', entries: [{ type: AuditEntryType.Branched, id: '01A' }, { type: AuditEntryType.Deleted, id: '01B' }] }],
  }];

  it('acknowledges the deletion as already consistent', async () => {
    const { receiver } = makeReceiver();

    const response = await receiver.process(request);

    expect(successIdsOf(response)).toEqual(['lost']);
  });

  it('does not persist anything', async () => {
    const { receiver, update } = makeReceiver();

    await receiver.process(request);

    expect(update).not.toHaveBeenCalled();
  });

  it('does not push anything back to the client', async () => {
    const { receiver, pushed } = makeReceiver();

    await receiver.process(request);

    expect(pushed).toEqual([]);
  });
});

// ─── Persistence not acknowledged ─────────────────────────────────────────────

describe('ServerReceiver when persistence does not acknowledge a merged record', () => {
  const record = { id: 'r1', name: 'client' };
  const request = (): ClientDispatcherRequest => [{
    collectionName: COLLECTION,
    records: [{ id: 'r1', hash: 'stale', entries: auditor.createAuditFrom(record).entries }],
  }];

  it('leaves the record out of the success response', async () => {
    const { receiver } = makeReceiver({ onUpdate: () => Promise.resolve([{ collectionName: COLLECTION, successfulRecordIds: [] }]) });

    const response = await receiver.process(request());

    expect(successIdsOf(response)).toEqual([]);
  });

  it('does not push the unpersisted state to the client', async () => {
    const { receiver, pushed } = makeReceiver({ onUpdate: () => Promise.resolve([{ collectionName: COLLECTION, successfulRecordIds: [] }]) });

    await receiver.process(request());

    expect(pushed).toEqual([]);
  });

  it('pushes the merged state once persistence acknowledges it and the client hash is stale', async () => {
    const { receiver, pushed } = makeReceiver({ onUpdate: () => Promise.resolve([{ collectionName: COLLECTION, successfulRecordIds: ['r1'] }]) });

    await receiver.process(request());

    expect(pushed[0]?.[0]?.records[0]).toMatchObject({ record, hash: 'hash-r1' });
  });
});

// ─── Merged deletions ─────────────────────────────────────────────────────────

describe('ServerReceiver when a merge results in a deletion the client initiated', () => {
  it('does not echo the delete back to a client that sent no hash', async () => {
    const created = auditor.createAuditFrom({ id: 'r1', name: 'server' });
    const deletedAudit = auditor.delete(created);
    const { receiver, pushed } = makeReceiver({
      onRetrieve: () => Promise.resolve([{ collectionName: COLLECTION, records: [{ record: { id: 'r1', name: 'server' }, audit: created.entries }] }]),
      onUpdate: () => Promise.resolve([{ collectionName: COLLECTION, successfulRecordIds: ['r1'] }]),
    });

    await receiver.process([{ collectionName: COLLECTION, records: [{ id: 'r1', entries: deletedAudit.entries.slice(1) as AuditEntry[] }] }]);

    expect(pushed).toEqual([]);
  });
});

// ─── Meta fast-path fallbacks ─────────────────────────────────────────────────

describe('ServerReceiver meta fast-path', () => {
  it('falls back to a full retrieve when the meta lookup returns nothing for the collection', async () => {
    const { receiver, retrieve } = makeReceiver({ onRetrieveMeta: () => Promise.resolve([{ collectionName: 'other', records: [] }]) });

    await receiver.process(branchOnly('r1', 'client-hash'));

    expect(retrieve).toHaveBeenCalledWith([{ collectionName: COLLECTION, recordIds: ['r1'] }]);
  });

  it('skips the meta lookup when no record is branched-only with a hash', async () => {
    const onRetrieveMeta = vi.fn(() => Promise.resolve([]));
    const { receiver } = makeReceiver({ onRetrieveMeta });

    await receiver.process(branchOnly('r1', undefined));

    expect(onRetrieveMeta).not.toHaveBeenCalled();
  });
});

// ─── Diagnostics ──────────────────────────────────────────────────────────────

describe('ServerReceiver diagnostics', () => {
  it('warns when processing a batch takes two seconds or more', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { logger, warn } = makeLogger();
    const { receiver } = makeReceiver({
      logger,
      onRetrieve: () => {
        vi.advanceTimersByTime(SLOW_PROCESS_MS);
        return Promise.resolve([]);
      },
    });

    await receiver.process(branchOnly('r1', 'client-hash'));

    expect(warn).toHaveBeenCalledWith('[SR] slow process', expect.objectContaining({ records: 1 }));
  });

  it('does not warn for a fast batch', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { logger, warn } = makeLogger();
    const { receiver } = makeReceiver({ logger });

    await receiver.process(branchOnly('r1', 'client-hash'));

    expect(warn).not.toHaveBeenCalled();
  });
});
