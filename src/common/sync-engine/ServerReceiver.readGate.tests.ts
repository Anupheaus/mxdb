import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@anupheaus/common'; // install Array/Object extensions used by the sync engine
import type { Logger, Record } from '@anupheaus/common';
import { auditor, AuditEntryType } from '../auditor';
import type { AuditEntry } from '../auditor';
import {
  OUTSIDE_READ_GATE_REASON,
  ServerReceiver,
  ServerDispatcher,
  type ClientDispatcherRequest,
  type MXDBReadableRecords,
  type MXDBRecordCursors,
  type MXDBRecordStates,
  type MXDBRecordStatesRequest,
  type MXDBSyncEngineResponse,
} from '.';

/**
 * A collection's read gate must hold on the C2S sync path too. A client can name any record id in a sync
 * request — a branch-only probe claiming a stale hash, or an update — and the receiver answers a disparity
 * with the stored record. Without the gate that hands a client any record whose id it knows (sc-583).
 *
 * `onReadReadable` is the server's answer to "which of these records may this client read", read through the gate
 * in one query; the receiver must never push a record outside it, never push a version other than the one it
 * returned (sc-682), and must not let a mere claim subscribe the client to later changes.
 */

vi.mock('../auditor/hash', () => ({
  hashRecord: (record: Record) => Promise.resolve(`hash-${JSON.stringify(record)}`),
  deterministicJson: (value: unknown) => JSON.stringify(value),
  contentHash: (value: unknown) => `content-${JSON.stringify(value)}`,
}));

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() } as unknown as Logger;

interface Note extends Record {
  text: string;
}

const COLLECTION = 'notes';
/** Sorts before every generated ULID. */
const EARLIEST_ULID = '00000000000000000000000000';
const readable: Note = { id: 'mine', text: 'my note' };
const gated: Note = { id: 'theirs', text: 'secret' };
const readableAudit = auditor.createAuditFrom(readable);
const gatedAudit = auditor.createAuditFrom(gated);

let dispatched: MXDBRecordCursors[];
let sd: ServerDispatcher;

beforeEach(() => {
  dispatched = [];
  sd = new ServerDispatcher(logger, {
    onDispatch: async payload => {
      dispatched.push(payload as MXDBRecordCursors);
      return payload.map(({ collectionName, records }) => ({
        collectionName,
        successfulRecordIds: records.map(cursor => ('record' in cursor ? cursor.record.id : cursor.recordId)),
      }));
    },
  });
});

/** Lets the dispatcher's async dispatch run. */
async function drain(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}

/** Every record id whose content (an active cursor) reached the client. */
function pushedRecordIds(): string[] {
  return dispatched.flatMap(payload => payload.flatMap(({ records }) => records.flatMap(cursor => ('record' in cursor ? [cursor.record.id] : []))));
}

/** Ids the client was told to drop, as real deletes and as evictions. */
function pushedRemovals(): { deleted: string[]; evicted: string[] } {
  const removals = dispatched.flatMap(payload => payload.flatMap(({ records }) => records.flatMap(cursor => ('record' in cursor ? [] : [cursor]))));
  return {
    deleted: removals.filter(({ isEviction }) => isEviction !== true).map(({ recordId }) => recordId),
    evicted: removals.filter(({ isEviction }) => isEviction === true).map(({ recordId }) => recordId),
  };
}

const storedStates: MXDBRecordStates = [{
  collectionName: COLLECTION,
  records: [{ record: readable, audit: readableAudit.entries }, { record: gated, audit: gatedAudit.entries }],
}];

/** The server's retrieve: only the requested ids that are stored. */
async function onRetrieve(request: MXDBRecordStatesRequest): Promise<MXDBRecordStates> {
  return request.map(({ collectionName, recordIds }) => ({
    collectionName,
    records: storedStates[0]!.records.filter(state => 'record' in state && recordIds.includes(state.record.id)),
  }));
}

/** The live records as stored now — what the gate reads. `onUpdate` writes to it. */
const liveById = new Map<string, Note>();
const liveRecords = (): Note[] => [...liveById.values()];
beforeEach(() => {
  liveById.clear();
  for (const note of [readable, gated]) liveById.set(note.id, note);
});

/** The gate: only `readable` passes, read as it is stored. */
const onReadReadable = vi.fn(async (request: MXDBRecordStatesRequest): Promise<MXDBReadableRecords> =>
  request.map(({ collectionName, recordIds }) => ({ collectionName, records: liveRecords().filter(({ id }) => id === readable.id && recordIds.includes(id)), isGated: true })));

/** Persists everything it is given, successfully. */
const onUpdate = vi.fn(async (states: MXDBRecordStates): Promise<MXDBSyncEngineResponse> => {
  for (const state of states.flatMap(({ records }) => records)) {
    if ('record' in state) liveById.set(state.record.id, state.record as Note);
    else liveById.delete(state.recordId);
  }
  return states.map(({ collectionName, records }) => ({ collectionName, successfulRecordIds: records.map(state => ('record' in state ? state.record.id : state.recordId)) }));
});

function receiver(): ServerReceiver {
  return new ServerReceiver(logger, { onRetrieve, onUpdate, onReadReadable, serverDispatcher: sd });
}

/**
 * A branch-only probe: the client claims to hold `id` at a hash that is not the server's, anchored before any
 * real entry (the lowest ULID) so the server's version always looks newer and is sent.
 */
function probe(id: string): ClientDispatcherRequest[0]['records'][0] {
  return { id, hash: 'stale-hash', entries: [{ type: AuditEntryType.Branched, id: EARLIEST_ULID } as AuditEntry] };
}

/** A change-stream push of a new version of `record` (reaches the client only if it is in the dispatcher's filter). */
function changeStreamPush(record: Note): void {
  sd.push([{ collectionName: COLLECTION, records: [{ record, lastAuditEntryId: auditor.generateUlid() }] }], false);
}

describe('ServerReceiver and the read gate', () => {
  beforeEach(() => {
    onReadReadable.mockClear();
    onUpdate.mockClear();
  });

  it('answers a branch-only probe for a gated record with an eviction, never its content', async () => {
    const response = await receiver().process([{ collectionName: COLLECTION, records: [probe(gated.id), probe(readable.id)] }]);
    await drain();
    expect(pushedRecordIds()).toEqual([readable.id]);
    expect(pushedRemovals()).toEqual({ deleted: [], evicted: [gated.id] });
    // The probe is still acknowledged, so a client that legitimately held the record stops resending it.
    expect(response[0]!.successfulRecordIds).toEqual(expect.arrayContaining([gated.id, readable.id]));
  });

  it('persists an update to a gated record but never pushes the merged record back — the device drops its copy', async () => {
    const clientEntries = auditor.updateAuditWith({ ...gated, text: 'edited' }, gatedAudit).entries.filter(({ type }) => type !== AuditEntryType.Created);
    await receiver().process([{ collectionName: COLLECTION, records: [{ id: gated.id, hash: 'stale-hash', entries: clientEntries }] }]);
    await drain();
    // Write authorisation is the before-write hooks' job; the gate governs what is read back.
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(pushedRecordIds()).toEqual([]);
    expect(pushedRemovals()).toEqual({ deleted: [], evicted: [gated.id] });
  });

  it('judges readability after the write, so a record the client creates inside its gate is pushed back', async () => {
    const created: Note = { id: 'mine', text: 'my note, amended' };
    const createdAudit = auditor.createAuditFrom(created);
    const onRetrieveNothing = async (): Promise<MXDBRecordStates> => [];
    const sr = new ServerReceiver(logger, { onRetrieve: onRetrieveNothing, onUpdate, onReadReadable, serverDispatcher: sd });
    await sr.process([{ collectionName: COLLECTION, records: [{ id: created.id, hash: 'client-hash', entries: createdAudit.entries }] }]);
    await drain();
    expect(onUpdate.mock.invocationCallOrder[0]!).toBeLessThan(onReadReadable.mock.invocationCallOrder[0]!);
    expect(pushedRecordIds()).toEqual([created.id]);
  });

  it('does not let a claim on a gated record subscribe the client to its later changes', async () => {
    await receiver().process([{ collectionName: COLLECTION, records: [probe(gated.id), probe(readable.id)] }]);
    await drain();
    dispatched = [];

    changeStreamPush({ ...gated, text: 'secret, changed' });
    changeStreamPush({ ...readable, text: 'my note, changed' });
    await drain();
    expect(pushedRecordIds()).toEqual([readable.id]);
  });

  it('evicts a record the client already holds at the current version once it may no longer read it (e.g. a lost capability)', async () => {
    // The meta fast-path confirms the client is up to date without a retrieve; that must not keep a gated record on it.
    const onRetrieveMeta = async (request: MXDBRecordStatesRequest) => request.map(({ collectionName, recordIds }) => ({ collectionName, records: recordIds.map(id => ({ id, hash: 'current' })) }));
    const sr = new ServerReceiver(logger, { onRetrieve, onRetrieveMeta, onUpdate, onReadReadable, serverDispatcher: sd });
    await sr.process([{ collectionName: COLLECTION, records: [{ ...probe(gated.id), hash: 'current' }, { ...probe(readable.id), hash: 'current' }] }]);
    await drain();
    expect(pushedRemovals()).toEqual({ deleted: [], evicted: [gated.id] });
    expect(pushedRecordIds()).toEqual([]);
  });

  it('answers a missing record exactly as a gated one, so a probe cannot tell them apart (sc-608)', async () => {
    await receiver().process([{ collectionName: COLLECTION, records: [probe('long-gone'), probe(gated.id)] }]);
    await drain();
    const cursors = dispatched.flatMap(payload => payload.flatMap(({ records }) => records));
    expect(cursors).toEqual([
      { recordId: 'long-gone', lastAuditEntryId: '', isEviction: true },
      { recordId: gated.id, lastAuditEntryId: '', isEviction: true },
    ]);
  });

  describe('an edit to an id the server never held (sc-998)', () => {
    const NEVER_HELD_ID = 'never-held';
    const neverHeld: Note = { id: NEVER_HELD_ID, text: 'made up' };
    const editEntries = auditor.updateAuditWith({ ...neverHeld, text: 'edited' }, auditor.createAuditFrom(neverHeld)).entries.filter(({ type }) => type !== AuditEntryType.Created);

    it.each([
      ['claiming a hash', 'stale-hash'],
      ['claiming no hash', undefined],
    ])('is refused with the read-gate reason and evicted, persisting nothing, %s', async (_label, hash) => {
      const response = await receiver().process([{ collectionName: COLLECTION, records: [{ id: NEVER_HELD_ID, ...(hash != null ? { hash } : {}), entries: editEntries }] }]);
      await drain();
      expect(response).toEqual([{ collectionName: COLLECTION, successfulRecordIds: [NEVER_HELD_ID], rejectedRecords: [{ id: NEVER_HELD_ID, reason: OUTSIDE_READ_GATE_REASON, kind: 'access' }] }]);
      expect(pushedRemovals()).toEqual({ deleted: [], evicted: [NEVER_HELD_ID] });
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it('is answered with a plain delete, and no refusal, when the server supplies no gate (unchanged behaviour)', async () => {
      const sr = new ServerReceiver(logger, { onRetrieve, onUpdate, serverDispatcher: sd });
      const response = await sr.process([{ collectionName: COLLECTION, records: [{ id: NEVER_HELD_ID, hash: 'stale-hash', entries: editEntries }] }]);
      await drain();
      expect(response).toEqual([{ collectionName: COLLECTION, successfulRecordIds: [NEVER_HELD_ID] }]);
      expect(pushedRemovals()).toEqual({ deleted: [NEVER_HELD_ID], evicted: [] });
    });
  });

  it('still tombstones a record the server holds as deleted, while answering it with an eviction', async () => {
    const deletedAudit = auditor.deleteAfterLatest(gatedAudit);
    const onRetrieveTombstone = async (): Promise<MXDBRecordStates> => [{ collectionName: COLLECTION, records: [{ recordId: gated.id, audit: auditor.entriesOf(deletedAudit) as AuditEntry[] }] }];
    const sr = new ServerReceiver(logger, { onRetrieve: onRetrieveTombstone, onUpdate, onReadReadable, serverDispatcher: sd });
    await sr.process([{ collectionName: COLLECTION, records: [probe(gated.id)] }]);
    await drain();
    expect(pushedRemovals()).toEqual({ deleted: [], evicted: [gated.id] });
    // Delete-is-final for this connection: even an authoritative push of the id is withheld now.
    dispatched = [];
    sd.push([{ collectionName: COLLECTION, records: [{ record: gated, lastAuditEntryId: auditor.generateUlid() }] }]);
    await drain();
    expect(pushedRecordIds()).toEqual([]);
  });

  it('pushes everything when the server supplies no gate (unchanged behaviour)', async () => {
    const sr = new ServerReceiver(logger, { onRetrieve, onUpdate, serverDispatcher: sd });
    await sr.process([{ collectionName: COLLECTION, records: [probe(gated.id), probe(readable.id)] }]);
    await drain();
    expect(pushedRecordIds().sort()).toEqual([readable.id, gated.id].sort());
  });
});

describe('ServerReceiver fails closed on the read gate', () => {
  /** Both notes change: which of them reaches the client through the change stream? */
  async function changeStreamReaches(): Promise<string[]> {
    dispatched = [];
    changeStreamPush({ ...gated, text: 'secret, changed' });
    changeStreamPush({ ...readable, text: 'my note, changed' });
    await drain();
    return pushedRecordIds();
  }

  it('leaves no claim subscribed when the read gate itself throws', async () => {
    const throwingGate = async (): Promise<MXDBReadableRecords> => { throw new Error('gate lookup failed'); };
    const sr = new ServerReceiver(logger, { onRetrieve, onUpdate, onReadReadable: throwingGate, serverDispatcher: sd });
    await expect(sr.process([{ collectionName: COLLECTION, records: [probe(gated.id), probe(readable.id)] }])).rejects.toThrow('gate lookup failed');
    await drain();
    expect(pushedRecordIds()).toEqual([]);
    // Every claim is forgotten — the readable one too; the client re-claims it on its retry.
    expect(await changeStreamReaches()).toEqual([]);
  });

  it('leaves no claim subscribed when the sync throws before the gate is reached', async () => {
    const failingRetrieve = async (): Promise<MXDBRecordStates> => { throw new Error('database unavailable'); };
    const sr = new ServerReceiver(logger, { onRetrieve: failingRetrieve, onUpdate, onReadReadable, serverDispatcher: sd });
    await expect(sr.process([{ collectionName: COLLECTION, records: [probe(gated.id)] }])).rejects.toThrow('database unavailable');
    expect(await changeStreamReaches()).toEqual([]);
  });

  it('does not let one sync finishing release a claim another, overlapping sync has not vetted yet', async () => {
    // The second sync's gate is held open until the test releases it.
    let releaseGate!: () => void;
    const gateHeld = new Promise<void>(resolve => { releaseGate = resolve; });
    const slowGate = async (request: MXDBRecordStatesRequest): Promise<MXDBReadableRecords> => { await gateHeld; return onReadReadable(request); };
    const slow = new ServerReceiver(logger, { onRetrieve, onUpdate, onReadReadable: slowGate, serverDispatcher: sd });

    const slowSync = slow.process([{ collectionName: COLLECTION, records: [probe(gated.id)] }]);
    await receiver().process([{ collectionName: COLLECTION, records: [probe(readable.id)] }]);
    // The first sync has finished and resumed its pause — but the second still holds the dispatcher.
    changeStreamPush({ ...gated, text: 'secret, changed' });
    await drain();
    expect(pushedRecordIds()).toEqual([]);

    releaseGate();
    await slowSync;
    await drain();
    // Vetted: the gated claim is dropped before the dispatcher resumes, so its change never goes out.
    expect(pushedRecordIds()).toEqual([readable.id]);
  });
});

describe('ServerReceiver with a request it cannot mirror', () => {
  it('rejects it without leaving the dispatcher paused', async () => {
    // Has a length (so it can be counted) but cannot be iterated (so mirroring it throws).
    const malformed = [{ collectionName: COLLECTION, records: { length: 1 } }] as unknown as ClientDispatcherRequest;
    await expect(receiver().process(malformed)).rejects.toThrow();
    // Were the pause outside the `finally`'s reach, nothing would ever be dispatched to this client again.
    sd.push([{ collectionName: COLLECTION, records: [{ record: readable, lastAuditEntryId: auditor.generateUlid() }] }]);
    await drain();
    expect(pushedRecordIds()).toEqual([readable.id]);
  });
});

describe('ServerReceiver: a record that changes while the sync runs (sc-682)', () => {
  /** A retrieve that returns `version` for `readable.id`, then lets `landChange` alter what is stored before the gate reads. */
  function receiverSeeing(version: Note, landChange: () => void): ServerReceiver {
    const retrieveThenChange = async (): Promise<MXDBRecordStates> => {
      const states: MXDBRecordStates = [{ collectionName: COLLECTION, records: [{ record: version, audit: auditor.createAuditFrom(version).entries }] }];
      landChange();
      return states;
    };
    return new ServerReceiver(logger, { onRetrieve: retrieveThenChange, onUpdate, onReadReadable, serverDispatcher: sd });
  }

  it('never sends the version read before the gate when the gate passes a newer one', async () => {
    // Read while still someone else's (its content is theirs); reassigned to this client before the gate reads it.
    const theirsVersion: Note = { id: readable.id, text: 'their private text' };
    const sr = receiverSeeing(theirsVersion, () => { liveById.set(readable.id, { id: readable.id, text: 'mine now' }); });

    await sr.process([{ collectionName: COLLECTION, records: [probe(readable.id)] }]);
    await drain();

    expect({ pushed: pushedRecordIds(), removals: pushedRemovals() }).toEqual({ pushed: [], removals: { deleted: [], evicted: [] } });
  });

  it('evicts, and sends nothing of, a record that leaves the gate (reassigned away) before the gate reads it', async () => {
    // The stub gate passes only what is stored under `readable.id`; a reassignment takes it out of what it returns.
    const sr = receiverSeeing(readable, () => { liveById.delete(readable.id); });

    await sr.process([{ collectionName: COLLECTION, records: [probe(readable.id)] }]);
    await drain();

    expect({ pushed: pushedRecordIds(), removals: pushedRemovals() }).toEqual({ pushed: [], removals: { deleted: [], evicted: [readable.id] } });
  });

  it('sends the version the gate passed when nothing changed in between', async () => {
    const sr = receiverSeeing(readable, () => undefined);

    await sr.process([{ collectionName: COLLECTION, records: [probe(readable.id)] }]);
    await drain();

    expect(pushedRecordIds()).toEqual([readable.id]);
  });
});
