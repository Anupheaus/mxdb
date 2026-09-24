import { is, type Record as MXDBRecord } from '@anupheaus/common';
import { auditor } from '../../common';
import type { MXDBCollection } from '../../common';
import type { AuditOf } from '../../common/auditor';
import {
  isActiveRecordState,
  type MXDBActiveRecordState,
  type MXDBDeletedRecordState,
  type MXDBSyncRejectedRecord,
} from '../../common/sync-engine';
import { runBeforeDeleteHook } from '../collections/runBeforeDeleteHook';
import { runBeforeUpsertHook } from '../collections/runBeforeUpsertHook';
import { getCollectionExtensions } from '../collections/extendCollection';

/** The parts of a server collection the before-write hooks need. */
export interface SyncHookCollection {
  collection: MXDBCollection;
  get(ids: string[]): Promise<MXDBRecord[]>;
}

type SyncState = MXDBActiveRecordState | MXDBDeletedRecordState;

export interface RunBeforeWriteHooksOnSyncStatesProps {
  collection: SyncHookCollection;
  /** One collection's merged client changes, about to be persisted. Amended in place (see below). */
  states: SyncState[];
}

export interface RunBeforeWriteHooksOnSyncStatesResult {
  /** Records a hook rejected, with the hook's reason — to be reported to the client. */
  rejectedRecords: MXDBSyncRejectedRecord[];
  /**
   * Ids of rejected deletes: they must NOT be persisted (the server keeps the record) but must still be
   * acknowledged, so the client stops resending a delete the server will never accept.
   */
  unpersistedIds: string[];
}

/**
 * Runs the collection's `onBeforeDelete` / `onBeforeUpsert` hooks for a batch of merged client changes,
 * before the batch is persisted — the synced-client counterpart of the hooks `ServerDbCollection.upsert` /
 * `remove` run for server-side writes.
 *
 * Hooks are invoked once PER RECORD (a payload of one), so a throw can be pinned on exactly that record;
 * the rest of the batch is unaffected. Each hook only sees an actual write, so re-sent changes do not fire
 * it twice: `onBeforeDelete` only for records still stored, `onBeforeUpsert` only for records that are new
 * or differ from their stored version.
 *
 * Outcomes, written back into `states` (the `ServerReceiver` reads them back after `onUpdate` and pushes
 * what was persisted to the client):
 * - amended by `onBeforeUpsert` → the state's record is replaced and an `Updated` entry appended;
 * - rejected update → the client's entries are kept and an `Updated` entry restoring the stored record is
 *   appended, so the client reverts;
 * - rejected create → the client's entries are kept and a `Deleted` entry appended (the state becomes a
 *   deleted state), so the client drops the record;
 * - rejected delete → left out of the write (see {@link RunBeforeWriteHooksOnSyncStatesResult.unpersistedIds}).
 * Server-authored entries always sort after the client's (see `auditor.updateAuditWithAfterLatest`).
 */
export async function runBeforeWriteHooksOnSyncStates({ collection, states }: RunBeforeWriteHooksOnSyncStatesProps): Promise<RunBeforeWriteHooksOnSyncStatesResult> {
  const result: RunBeforeWriteHooksOnSyncStatesResult = { rejectedRecords: [], unpersistedIds: [] };
  const { collection: definition, get } = collection;
  const extensions = getCollectionExtensions(definition);
  // Without a hook there is nothing to run, so skip the read of the stored records entirely.
  if (extensions?.onBeforeUpsert == null && extensions?.onBeforeDelete == null) return result;

  const storedRecords = await get(states.map(stateIdOf));
  const storedById = new Map(storedRecords.map(record => [record.id, record] as const));

  for (let index = 0; index < states.length; index++) {
    const state = states[index]!;
    const id = stateIdOf(state);
    const stored = storedById.get(id);
    try {
      if (isActiveRecordState(state)) {
        await amendWithBeforeUpsertHook({ definition, state, stored });
      } else {
        await runBeforeDeleteHook({ collection: definition, recordIds: [id], getStoredIds: async ids => ids.filter(storedId => storedById.has(storedId)) });
      }
    } catch (error) {
      result.rejectedRecords.push({ id, reason: describeRejection(error) });
      if (isActiveRecordState(state)) states[index] = revertRejectedState(state, stored);
      else result.unpersistedIds.push(id);
    }
  }
  return result;
}

function stateIdOf(state: SyncState): string {
  return isActiveRecordState(state) ? state.record.id : state.recordId;
}

interface AmendWithBeforeUpsertHookProps {
  definition: MXDBCollection;
  state: MXDBActiveRecordState;
  stored: MXDBRecord | undefined;
}

/** Runs `onBeforeUpsert` for one changing record and folds any amendment into its state. Throws if the hook does. */
async function amendWithBeforeUpsertHook({ definition, state, stored }: AmendWithBeforeUpsertHookProps): Promise<void> {
  if (stored != null && is.deepEqual(stored, state.record)) return;
  const [recordToWrite] = await runBeforeUpsertHook({ collection: definition, records: [state.record], existingRecords: stored == null ? [] : [stored] });
  if (recordToWrite == null || is.deepEqual(recordToWrite, state.record)) return;
  const amendedAudit = auditor.updateAuditWithAfterLatest(recordToWrite, auditOf(state), state.record);
  state.record = recordToWrite;
  state.audit = auditor.entriesOf(amendedAudit);
}

/**
 * The state that undoes a rejected client change while keeping its entries: back to the stored record, or —
 * for a record the server never stored (a rejected create) — deleted.
 */
function revertRejectedState(state: MXDBActiveRecordState, stored: MXDBRecord | undefined): SyncState {
  const audit = auditOf(state);
  if (stored == null) return { recordId: state.record.id, audit: auditor.entriesOf(auditor.deleteAfterLatest(audit)) };
  return { record: stored, audit: auditor.entriesOf(auditor.updateAuditWithAfterLatest(stored, audit, state.record)) };
}

function auditOf(state: MXDBActiveRecordState): AuditOf<MXDBRecord> {
  return { id: state.record.id, entries: state.audit } as AuditOf<MXDBRecord>;
}

/** The hook's thrown value as a message the client can show. */
function describeRejection(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    // Not serialisable (e.g. circular) — fall back to its string form.
    return String(error);
  }
}
