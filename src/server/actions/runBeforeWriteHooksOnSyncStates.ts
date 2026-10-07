import { ValidationError, is, type Record as MXDBRecord } from '@anupheaus/common';
import { auditor } from '../../common';
import type { MXDBCollection } from '../../common';
import type { AuditOf } from '../../common/auditor';
import {
  isActiveRecordState,
  type MXDBActiveRecordState,
  type MXDBDeletedRecordState,
  type MXDBSyncAmendedRecord,
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
  /** Ids already refused before the hooks (e.g. outside the read gate): left untouched, and no hook runs for them. */
  excludedIds?: ReadonlySet<string>;
}

export interface RunBeforeWriteHooksOnSyncStatesResult {
  /** Records a hook rejected, with the hook's reason — to be reported to the client. */
  rejectedRecords: MXDBSyncRejectedRecord[];
  /**
   * Records a hook amended and said so for (it returned a note), with the note — to be reported to the client.
   * Only a record the hook actually changed, and did not then reject, is reported.
   */
  amendedRecords: MXDBSyncAmendedRecord[];
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
 * - amended by `onBeforeUpsert` → the state's record is replaced and an `Updated` entry appended (and, when the
 *   hook returned a note for it, reported in {@link RunBeforeWriteHooksOnSyncStatesResult.amendedRecords});
 * - rejected update → the client's entries are kept and an `Updated` entry restoring the stored record is
 *   appended, so the client reverts;
 * - rejected create → the client's entries are kept and a `Deleted` entry appended (the state becomes a
 *   deleted state), so the client drops the record;
 * - rejected delete → left out of the write (see {@link RunBeforeWriteHooksOnSyncStatesResult.unpersistedIds}).
 * Server-authored entries always sort after the client's (see `auditor.updateAuditWithAfterLatest`).
 */
export async function runBeforeWriteHooksOnSyncStates({ collection, states, excludedIds }: RunBeforeWriteHooksOnSyncStatesProps): Promise<RunBeforeWriteHooksOnSyncStatesResult> {
  const result: RunBeforeWriteHooksOnSyncStatesResult = { rejectedRecords: [], amendedRecords: [], unpersistedIds: [] };
  const { collection: definition, get } = collection;
  const extensions = getCollectionExtensions(definition);
  // Without a hook there is nothing to run, so skip the read of the stored records entirely.
  if (extensions?.onBeforeUpsert == null && extensions?.onBeforeDelete == null) return result;

  const storedRecords = await get(states.map(stateIdOf));
  const storedById = new Map(storedRecords.map(record => [record.id, record] as const));

  for (let index = 0; index < states.length; index++) {
    const state = states[index]!;
    const id = stateIdOf(state);
    if (excludedIds?.has(id) === true) continue;
    const stored = storedById.get(id);
    try {
      if (isActiveRecordState(state)) {
        result.amendedRecords.push(...await amendWithBeforeUpsertHook({ definition, state, stored }));
      } else {
        await runBeforeDeleteHook({ collection: definition, recordIds: [id], getStoredIds: async ids => ids.filter(storedId => storedById.has(storedId)) });
      }
    } catch (error) {
      result.rejectedRecords.push({ id, reason: describeRejection(error), kind: isValidationError(error) ? 'validation' : 'error' });
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

/**
 * Runs `onBeforeUpsert` for one changing record and folds any amendment into its state. Throws if the hook does.
 * Returns the hook's notes for the record, and only when it really changed it (a note for an untouched record
 * would tell the user something was put back when nothing was) and only for this record's id.
 */
async function amendWithBeforeUpsertHook({ definition, state, stored }: AmendWithBeforeUpsertHookProps): Promise<MXDBSyncAmendedRecord[]> {
  if (stored != null && is.deepEqual(stored, state.record)) return [];
  const { records, amendmentNotes } = await runBeforeUpsertHook({ collection: definition, records: [state.record], existingRecords: stored == null ? [] : [stored] });
  const [recordToWrite] = records;
  if (recordToWrite == null || is.deepEqual(recordToWrite, state.record)) return [];
  const amendedAudit = auditor.updateAuditWithAfterLatest(recordToWrite, auditOf(state), state.record);
  const recordId = state.record.id;
  state.record = recordToWrite;
  state.audit = auditor.entriesOf(amendedAudit);
  return amendmentNotes.filter(({ id }) => id === recordId).map(({ note }) => ({ id: recordId, note }));
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

/**
 * Whether a hook refused with a `ValidationError` — a message written for the user. Checked by name as well as by
 * class, because the app's hooks may throw it from a different copy of `@anupheaus/common` than mxdb's own.
 */
function isValidationError(error: unknown): boolean {
  return error instanceof ValidationError || (error instanceof globalThis.Error && error.name === 'ValidationError');
}

/** The hook's thrown value as the rejection's reason (shown to the user only for a validation rejection). */
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
