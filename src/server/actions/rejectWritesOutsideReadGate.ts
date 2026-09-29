import type { DataFilters, Record as MXDBRecord } from '@anupheaus/common';
import type { MXDBCollection } from '../../common';
import { isActiveRecordState, type MXDBActiveRecordState, type MXDBDeletedRecordState, type MXDBSyncRejectedRecord } from '../../common/sync-engine';
import { useQueryGate } from '../collections/useQueryGate';

/** Shown to the user whose change was refused; the record is someone else's to change. */
export const OUTSIDE_READ_GATE_REASON = 'You do not have access to change this record.';

/** The parts of a server collection the write gate needs. */
export interface ReadGateWriteCollection {
  collection: MXDBCollection;
  /** Ids of the stored records matching the filters (a projection — see `ServerDbCollection.queryIds`). */
  queryIds(filters: DataFilters<MXDBRecord>): Promise<string[]>;
}

export interface RejectWritesOutsideReadGateProps {
  collection: ReadGateWriteCollection;
  /** One collection's merged client changes, about to be persisted. */
  states: (MXDBActiveRecordState | MXDBDeletedRecordState)[];
}

export interface RejectWritesOutsideReadGateResult {
  /** The refused changes, with the reason to report to the client. */
  rejectedRecords: MXDBSyncRejectedRecord[];
  /** Their ids: left out of the write entirely, but acknowledged so the client stops resending them. */
  unpersistedIds: string[];
}

/**
 * The read gate applied to client writes: a client may not update or delete a record whose STORED version is
 * outside the collection's `onQuery` gate for them — a record it cannot read is not its to change. Without
 * this, a fitter who knew a task's id could add themself to its assignees (and so read it) or delete it.
 * Creating a record is always allowed (nothing is stored under the id yet); the collection's before-write
 * hooks still decide whether the create itself is acceptable. Anything that must legitimately change a
 * record outside the caller's read scope belongs in a server action, not a synced write.
 *
 * A refused change is not persisted at all — not even its audit entries, since they were never the client's
 * to add — and nothing is pushed back: the stored record is exactly what the client may not see.
 */
export async function rejectWritesOutsideReadGate({ collection, states }: RejectWritesOutsideReadGateProps): Promise<RejectWritesOutsideReadGateResult> {
  const result: RejectWritesOutsideReadGateResult = { rejectedRecords: [], unpersistedIds: [] };
  const { collection: definition, queryIds } = collection;
  const gateFilters = await useQueryGate<MXDBRecord>(definition).getGateFilters();
  if (gateFilters == null || states.length === 0) return result;

  const ids = states.map(state => (isActiveRecordState(state) ? state.record.id : state.recordId));
  const storedIds = await queryIds({ id: { $in: ids } });
  if (storedIds.length === 0) return result;
  const readableIds = new Set(await queryIds({ $and: [{ id: { $in: storedIds } }, gateFilters] }));

  for (const id of storedIds) {
    if (readableIds.has(id)) continue;
    result.rejectedRecords.push({ id, reason: OUTSIDE_READ_GATE_REASON });
    result.unpersistedIds.push(id);
  }
  return result;
}
