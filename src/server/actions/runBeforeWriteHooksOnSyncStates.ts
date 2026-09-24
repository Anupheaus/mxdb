import { is, type Record as MXDBRecord } from '@anupheaus/common';
import { auditor } from '../../common';
import type { MXDBCollection } from '../../common';
import type { AuditOf } from '../../common/auditor';
import { isActiveRecordState, type MXDBActiveRecordState, type MXDBDeletedRecordState } from '../../common/sync-engine';
import { runBeforeDeleteHook } from '../collections/runBeforeDeleteHook';
import { runBeforeUpsertHook } from '../collections/runBeforeUpsertHook';
import { getCollectionExtensions } from '../collections/extendCollection';

/** The parts of a server collection the before-write hooks need. */
export interface SyncHookCollection {
  collection: MXDBCollection;
  get(ids: string[]): Promise<MXDBRecord[]>;
}

export interface RunBeforeWriteHooksOnSyncStatesProps {
  collection: SyncHookCollection;
  /** One collection's merged client changes, about to be persisted. Amended in place (see below). */
  states: (MXDBActiveRecordState | MXDBDeletedRecordState)[];
}

/**
 * Runs the collection's `onBeforeDelete` / `onBeforeUpsert` hooks for a batch of merged client changes,
 * before the batch is persisted — the synced-client counterpart of the hooks `ServerDbCollection.upsert` /
 * `remove` run for server-side writes.
 *
 * Each hook only sees an actual write, so re-sent changes do not fire it twice:
 * - `onBeforeDelete` gets the records being deleted that are still stored;
 * - `onBeforeUpsert` gets the records that are new or differ from their stored version.
 *
 * When `onBeforeUpsert` amends a record, the amendment is written back into its state: the state's record
 * is replaced and an `Updated` audit entry describing the amendment is appended. That keeps the persisted
 * audit replaying to the persisted record, and lets the `ServerReceiver` (which reads the states back after
 * `onUpdate`) push the amended record to the client that sent it. A hook that throws rejects the batch.
 */
export async function runBeforeWriteHooksOnSyncStates({ collection, states }: RunBeforeWriteHooksOnSyncStatesProps): Promise<void> {
  const { collection: definition, get } = collection;
  const activeStates = states.filter(isActiveRecordState);
  const deletedIds = states.filter(state => !isActiveRecordState(state)).map(state => (state as MXDBDeletedRecordState).recordId);

  await runBeforeDeleteHook({ collection: definition, recordIds: deletedIds, getStoredIds: async ids => (await get(ids)).ids() });

  // Without a hook there is nothing to feed, so skip the read of the stored records entirely.
  if (activeStates.length === 0 || getCollectionExtensions(definition)?.onBeforeUpsert == null) return;
  await amendStatesWithBeforeUpsertHook({ definition, get, activeStates });
}

interface AmendStatesProps {
  definition: MXDBCollection;
  get(ids: string[]): Promise<MXDBRecord[]>;
  activeStates: MXDBActiveRecordState[];
}

async function amendStatesWithBeforeUpsertHook({ definition, get, activeStates }: AmendStatesProps): Promise<void> {
  const existingRecords = await get(activeStates.map(state => state.record.id));
  const existingById = new Map(existingRecords.map(record => [record.id, record] as const));
  const changingStates = activeStates.filter(state => {
    const existing = existingById.get(state.record.id);
    return existing == null || !is.deepEqual(existing, state.record);
  });
  if (changingStates.length === 0) return;

  const recordsToWrite = await runBeforeUpsertHook({ collection: definition, records: changingStates.map(state => state.record), existingRecords });
  changingStates.forEach((state, index) => {
    const recordToWrite = recordsToWrite[index]!;
    if (is.deepEqual(recordToWrite, state.record)) return;
    const amendedAudit = auditor.updateAuditWith(recordToWrite, { id: state.record.id, entries: state.audit } as AuditOf<MXDBRecord>, state.record);
    state.record = recordToWrite;
    state.audit = auditor.entriesOf(amendedAudit);
  });
}
