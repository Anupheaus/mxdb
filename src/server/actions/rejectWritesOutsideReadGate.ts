import type { DataFilters, Record as MXDBRecord } from '@anupheaus/common';
import type { MXDBCollection } from '../../common';
import { auditor, AuditEntryType, type AnyAuditOf, type AuditEntry, type ServerAuditOf } from '../../common/auditor';
import { isActiveRecordState, toOutsideReadGateRejection, type MXDBActiveRecordState, type MXDBDeletedRecordState, type MXDBSyncRejectedRecord } from '../../common/sync-engine';
import { useQueryGate } from '../collections/useQueryGate';

/** Why a change was refused — for the server's logs only; the client gets one reason for every case (sc-998). */
export type RefusedWriteCause = 'outside-read-gate' | 'deleted';

/** A refused change and its cause, to log. */
export interface RefusedWriteDetails {
  id: string;
  cause: RefusedWriteCause;
}

type SyncState = MXDBActiveRecordState | MXDBDeletedRecordState;

/** The parts of a server collection the write gate needs (a `ServerDbCollection` provides them). */
export interface ReadGateWriteCollection {
  collection: MXDBCollection;
  /** Ids of the live records matching the filters (a projection — see `ServerDbCollection.queryIds`). */
  queryIds(filters: DataFilters<MXDBRecord>): Promise<string[]>;
  /** Of the ids, those with a stored audit, deleted records included (see `ServerDbCollection.getAuditIds`). */
  getAuditIds(ids: string[]): Promise<string[]>;
  get(ids: string[]): Promise<MXDBRecord[]>;
  getAudit(ids: string[]): Promise<ServerAuditOf<MXDBRecord>[]>;
}

export interface RejectWritesOutsideReadGateProps {
  collection: ReadGateWriteCollection;
  /** One collection's merged client changes, about to be persisted. Refused ones are replaced in place (see below). */
  states: SyncState[];
}

export interface RejectWritesOutsideReadGateResult {
  /** The refused changes, with the reason to report to the client: the same for every cause. */
  rejectedRecords: MXDBSyncRejectedRecord[];
  /** Why each was refused, for the server's logs. Never sent to the client: it would tell it whether the record exists. */
  refusedWrites: RefusedWriteDetails[];
  /** Their ids: left out of the write entirely, but acknowledged so the client stops resending them. */
  unpersistedIds: string[];
}

/**
 * The read gate applied to client writes, for a collection with an `onQuery` gate. A client may not change a
 * record whose stored version is outside the gate for them — a record it cannot read is not its to change.
 * Without this, a fitter who knew a task's id could add themself to its assignees (and so read it) or delete it.
 * The gate is asked with `purpose: 'write'`, so a scope that only limits delivery (a device's date window) does
 * not refuse an offline edit to a record that has left it since: the edit is saved, then the record is evicted.
 *
 * - A **live** record outside the caller's gate: the update or delete is refused.
 * - A **deleted** record (its audit is a tombstone): any change is refused, whoever asks. Its gate cannot be
 *   judged on a record that is not live, deletes are final, and a client-sent `Restored` entry would otherwise
 *   resurrect the server's last content — for a record the caller may never have been allowed to read.
 * - An id the server has never held is a **create**, and is allowed; the before-write hooks still judge it. (A
 *   collection with `disableAudit` keeps no tombstones, so there a deleted id looks new — it holds nothing to leak.)
 *
 * The client is given the same refusal for both (and the `ServerReceiver` gives it for an edit to an id never held), so
 * it cannot learn from the answer whether a record it may not read exists (sc-998). The cause goes to the server's logs.
 *
 * A refused change is not persisted at all — not even its audit entries, which were never the client's to add.
 * Its state is replaced, in place, by what the server holds (the stored record, or the tombstone), so the
 * receiver, reading the states back, never sees the client's merged version: it pushes the stored record only
 * if the caller may read it, and for a tombstone only a delete. Anything that must legitimately change a record
 * outside the caller's read scope belongs in a server action, not a synced write.
 */
export async function rejectWritesOutsideReadGate({ collection, states }: RejectWritesOutsideReadGateProps): Promise<RejectWritesOutsideReadGateResult> {
  const result: RejectWritesOutsideReadGateResult = { rejectedRecords: [], refusedWrites: [], unpersistedIds: [] };
  const { collection: definition, queryIds, getAuditIds, get, getAudit } = collection;
  // Asked as a write: a scope that only limits what is delivered (a device's window) must not refuse a change.
  const gateFilters = await useQueryGate<MXDBRecord>(definition).getGateFilters('write');
  if (gateFilters == null || states.length === 0) return result;

  const ids = states.map(stateIdOf);
  const liveIds = await queryIds({ id: { $in: ids } });
  const auditedIds = await getAuditIds(ids);
  const deletedIds = auditedIds.filter(id => !liveIds.includes(id));
  if (liveIds.length === 0 && deletedIds.length === 0) return result;
  const readableIds = liveIds.length === 0 ? [] : await queryIds({ $and: [{ id: { $in: liveIds } }, gateFilters] });

  const refusedLiveIds = liveIds.filter(id => !readableIds.includes(id));
  const heldBackIds = [...refusedLiveIds, ...deletedIds];
  if (heldBackIds.length === 0) return result;

  const storedStates = await loadStoredStates({ get, getAudit, liveIds: refusedLiveIds, auditedIds, refusedIds: heldBackIds });
  const incomingById = new Map(states.map(state => [stateIdOf(state), state] as const));
  const refusedWrites: RefusedWriteDetails[] = [
    ...refusedLiveIds.map(id => ({ id, cause: 'outside-read-gate' as const })),
    // Deleting a record that is already deleted (two people deleting it, or a delete resent after a lost ack) changes
    // nothing, so it is acknowledged quietly; any other change to a deleted record is refused.
    ...deletedIds
      .filter(id => !isOnlyARepeatedDelete({ incoming: incomingById.get(id), stored: storedStates.get(id) }))
      .map(id => ({ id, cause: 'deleted' as const })),
  ];

  states.forEach((state, index) => {
    const stored = storedStates.get(stateIdOf(state));
    if (stored != null) states[index] = stored;
  });
  result.rejectedRecords.push(...refusedWrites.map(({ id }) => toOutsideReadGateRejection(id)));
  result.refusedWrites.push(...refusedWrites);
  result.unpersistedIds.push(...heldBackIds);
  return result;
}

interface IsOnlyARepeatedDeleteProps {
  incoming: SyncState | undefined;
  stored: SyncState | undefined;
}

/** True when the client's change to a deleted record adds nothing but another delete (its new entries are only `Deleted`/`Branched`). */
function isOnlyARepeatedDelete({ incoming, stored }: IsOnlyARepeatedDeleteProps): boolean {
  if (incoming == null || isActiveRecordState(incoming)) return false;
  const storedEntryIds = new Set((stored?.audit ?? []).map(({ id }) => id));
  return incoming.audit
    .filter(({ id }) => !storedEntryIds.has(id))
    .every(({ type }) => type === AuditEntryType.Deleted || type === AuditEntryType.Branched);
}

function stateIdOf(state: SyncState): string {
  return isActiveRecordState(state) ? state.record.id : state.recordId;
}

interface LoadStoredStatesProps extends Pick<ReadGateWriteCollection, 'get' | 'getAudit'> {
  liveIds: string[];
  /** Ids with a stored audit: only these are read from the audit collection (a `disableAudit` collection has none). */
  auditedIds: string[];
  refusedIds: string[];
}

/** What the server holds for each refused id: the live record with its audit, or the tombstone. */
async function loadStoredStates({ get, getAudit, liveIds, auditedIds, refusedIds }: LoadStoredStatesProps): Promise<Map<string, SyncState>> {
  const auditIdsToRead = refusedIds.filter(id => auditedIds.includes(id));
  const [records, audits] = await Promise.all([
    liveIds.length === 0 ? [] : get(liveIds),
    auditIdsToRead.length === 0 ? [] : getAudit(auditIdsToRead),
  ]);
  const entriesById = new Map(audits.map(audit => [audit.id, auditor.entriesOf(audit as unknown as AnyAuditOf<MXDBRecord>) as AuditEntry[]] as const));
  const recordsById = new Map(records.map(record => [record.id, record] as const));
  return new Map(refusedIds.map((id): [string, SyncState] => {
    const record = recordsById.get(id);
    const audit = entriesById.get(id) ?? [];
    return [id, record != null ? { record, audit } : { recordId: id, audit }];
  }));
}
