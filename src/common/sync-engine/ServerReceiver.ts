import type { Logger, Record as MXDBRecord } from '@anupheaus/common';
import { auditor, AuditEntryType } from '../auditor';
import { replayHistoryEndState } from '../auditor/replay';
import { hashRecord } from '../auditor/hash';
import type { AuditEntry } from '../auditor';
import {
  type ClientDispatcherRequest,
  type MXDBRecordStatesRequest,
  type MXDBRecordStates,
  type MXDBRecordMetas,
  type MXDBActiveRecordState,
  type MXDBDeletedRecordState,
  type MXDBActiveRecordCursor,
  type MXDBDeletedRecordCursor,
  type MXDBSyncEngineResponse,
  type ServerDispatcherFilter,
  type MXDBRecordCursors,
} from './models';
import type { ServerDispatcher } from './ServerDispatcher';
import { isActiveRecordState } from './utils';

interface ServerReceiverProps {
  onRetrieve(request: MXDBRecordStatesRequest): Promise<MXDBRecordStates>;
  /** Optional cheap projection of stored `_meta` (hash only) for the meta fast-path. When absent the
   *  receiver always takes the full-retrieve path (current behaviour). */
  onRetrieveMeta?(request: MXDBRecordStatesRequest): Promise<MXDBRecordMetas>;
  /**
   * Persists the merged states. Before persisting it may amend a state in place (replace `record` and
   * extend `audit` to match) or replace it in its collection's `records` array with a state for the same
   * record (e.g. an active state reverted to deleted) — server before-write hooks do both. The receiver
   * reads the states back afterwards so disparity pushes carry what was actually persisted, and passes
   * any `rejectedRecords` in the response through to the client.
   */
  onUpdate(records: MXDBRecordStates): Promise<MXDBSyncEngineResponse>;
  serverDispatcher: ServerDispatcher;
}

/**
 * `ServerReceiver.process` flow:
 *
 * 1. Pause the SD (queued pushes hold until we resume).
 * 2. **Synchronously** seed `#filter` via `sd.updateFilter(...)` from the
 *    `ClientDispatcherRequest`. The mirror reflects what the client CLAIMS to
 *    currently have (its hashes and the max audit-entry ID it knows about). This
 *    must happen before any `await` so that concurrent change-stream events
 *    landing on this SD's queue can be evaluated against an accurate filter when
 *    we later `resume()`.
 * 3. Retrieve current server state via `onRetrieve`.
 * 4. For each client record, process:
 *      a. Branched-only: no entries to merge; compare client hash vs server
 *         hash. Match → nothing to push. Mismatch → disparity push (active or
 *         delete cursor). If the server has no state at all and the client still
 *         reports an active hash, push a delete (reconnect ghost cleanup).
 *      b. Has entries: merge into server audit, replay to get the live record,
 *         persist via `onUpdate`. If the post-merge hash differs from the client
 *         hash, or the merged result is a deletion that the client didn't know
 *         about, push the disparity cursor. Records whose first non-Branched entry
 *         is not Created and the server has no state are treated as server-origin
 *         ghosts and receive a delete cursor — client Created records are excluded.
 * 5. All disparity pushes go through `sd.push(payload)` with the default
 *    `addToFilter=true`. Since the mirror set in step 2 has the client's old
 *    hash and the cursor carries the new (server/merged) hash, the SD's filter
 *    check picks them up as mismatches and dispatches them.
 * 6. Resume the SD.
 */
let srIdCounter = 0;

export class ServerReceiver {
  readonly #logger: Logger;
  readonly #props: ServerReceiverProps;

  constructor(logger: Logger, props: ServerReceiverProps) {
    this.#logger = logger;
    this.#props = props;
    this.#logger.debug('[SR] ServerReceiver created');
  }

  async process(request: ClientDispatcherRequest): Promise<MXDBSyncEngineResponse> {
    const { serverDispatcher } = this.#props;
    const processT0 = performance.now();
    const totalRecords = request.reduce((acc, c) => acc + c.records.length, 0);
    const srId = `sr#${++srIdCounter}`;

    // Step 1: Pause the SD so queued/pending dispatches hold until we finish.
    serverDispatcher.pause();

    // Step 2: Synchronously mirror the client's claimed state into #filter.
    // MUST happen before any await — any change-stream event that races with
    // this C2S call will be evaluated against this mirror when we resume.
    const mirrorFilters = this.#buildMirrorFilter(request);
    if (mirrorFilters.length > 0) serverDispatcher.updateFilter(mirrorFilters);
    const mirrorMs = Math.round(performance.now() - processT0);

    try {
      // Meta fast-path: a branched-only record (nothing to merge) that the client already holds at the
      // server's current hash is consistent — confirm it from the stored `_meta.hash` instead of
      // fetching and re-hashing the whole record. Falls back to the full path when no meta callback is
      // wired or the stored hash is absent/different.
      const isBranchedOnly = (rec: { entries: AuditEntry[] }) => rec.entries.every(e => e.type === AuditEntryType.Branched);
      const metaMatched = new Map<string, Set<string>>(); // collectionName -> ids confirmed consistent via meta
      if (this.#props.onRetrieveMeta != null) {
        const metaRequest: MXDBRecordStatesRequest = [];
        for (const item of request) {
          const recordIds = item.records.filter(r => r.hash != null && isBranchedOnly(r)).map(r => r.id);
          if (recordIds.length > 0) metaRequest.push({ collectionName: item.collectionName, recordIds });
        }
        if (metaRequest.length > 0) {
          const metas = await this.#props.onRetrieveMeta(metaRequest);
          const hashByColId = new Map(metas.map(m => [m.collectionName, new Map(m.records.map(r => [r.id, r.hash]))]));
          for (const item of request) {
            const colHashes = hashByColId.get(item.collectionName);
            if (colHashes == null) continue;
            for (const rec of item.records) {
              if (rec.hash != null && isBranchedOnly(rec) && colHashes.get(rec.id) === rec.hash) {
                let set = metaMatched.get(item.collectionName);
                if (set == null) { set = new Set(); metaMatched.set(item.collectionName, set); }
                set.add(rec.id);
              }
            }
          }
        }
      }

      // Step 3: Retrieve current server state — for every record EXCEPT those already confirmed via meta.
      const retrieveRequest: MXDBRecordStatesRequest = request
        .map(item => ({
          collectionName: item.collectionName,
          recordIds: item.records.map(r => r.id).filter(id => metaMatched.get(item.collectionName)?.has(id) !== true),
        }))
        .filter(item => item.recordIds.length > 0);

      const retrieveT0 = performance.now();
      const serverStates = retrieveRequest.length > 0 ? await this.#props.onRetrieve(retrieveRequest) : [];
      const retrieveMs = Math.round(performance.now() - retrieveT0);

      const serverStateMap = new Map<string, Map<string, MXDBActiveRecordState | MXDBDeletedRecordState>>();
      for (const col of serverStates) {
        const colMap = new Map<string, MXDBActiveRecordState | MXDBDeletedRecordState>();
        for (const state of col.records) {
          const id = isActiveRecordState(state) ? state.record.id : state.recordId;
          colMap.set(id, state);
        }
        serverStateMap.set(col.collectionName, colMap);
      }

      // Step 4: Process each record — merge if entries, compute disparities.
      type PendingPersistItem = {
        collectionName: string;
        recordId: string;
        mergedEntries: AuditEntry[];
        liveRecord: MXDBRecord | undefined;
        clientHash?: string;
      };

      const mergeT0 = performance.now();
      const pendingPersist: PendingPersistItem[] = [];
      const branchOnlyDisparities: Array<{
        collectionName: string;
        recordId: string;
        clientHash?: string;
        lastAuditEntryId: string;
        serverState: MXDBActiveRecordState | MXDBDeletedRecordState | undefined;
      }> = [];
      const branchOnlySuccessIds = new Map<string, string[]>();

      for (const item of request) {
        const colName = item.collectionName;
        const colServerMap = serverStateMap.get(colName) ?? new Map();
        const metaMatchedCol = metaMatched.get(colName);

        for (const rec of item.records) {
          const recordId = rec.id;

          // Confirmed consistent via the stored hash — never retrieved, nothing to merge or push.
          if (metaMatchedCol?.has(recordId)) {
            if (!branchOnlySuccessIds.has(colName)) branchOnlySuccessIds.set(colName, []);
            branchOnlySuccessIds.get(colName)!.push(recordId);
            continue;
          }

          const strippedEntries = rec.entries.filter(e => e.type !== AuditEntryType.Branched);

          if (strippedEntries.length === 0) {
            // Branched-only: nothing to merge. Compare with server state and
            // queue a disparity push if needed.
            const serverState = colServerMap.get(recordId);
            branchOnlyDisparities.push({
              collectionName: colName,
              recordId,
              clientHash: rec.hash,
              lastAuditEntryId: this.#getLastAuditEntryId(rec.entries),
              serverState,
            });
            if (!branchOnlySuccessIds.has(colName)) branchOnlySuccessIds.set(colName, []);
            branchOnlySuccessIds.get(colName)!.push(recordId);
            continue;
          }

          const serverState = colServerMap.get(recordId);

          // NOTE: tombstoned server state is NOT a short-circuit. Audit entries must never
          // be lost: if a stale client dispatches Updated entries with ULIDs that fall after
          // a delete that has already persisted, those entries still need to be merged into
          // the audit (replay correctly keeps `live = undefined` after the first Delete and
          // only mutates `shadow`, so post-delete updates change the audit length without
          // resurrecting the record — only a Restored entry can resurrect, and that path is
          // not yet implemented). Fall through to the normal merge path below.

          let mergedEntries: AuditEntry[];

          if (serverState == null) {
            // New record: first entry must be Created, or the sole entry is Deleted
            // (client is deleting a record the server already lost — already consistent).
            if (strippedEntries[0]!.type !== AuditEntryType.Created) {
              const isClientDeletion = strippedEntries.some(e => e.type === AuditEntryType.Deleted);
              if (isClientDeletion) {
                if (!branchOnlySuccessIds.has(colName)) branchOnlySuccessIds.set(colName, []);
                branchOnlySuccessIds.get(colName)!.push(recordId);
              } else if (rec.hash != null) {
                // Existing / updated record the server no longer has — tell the client to drop it.
                branchOnlyDisparities.push({
                  collectionName: colName,
                  recordId,
                  clientHash: rec.hash,
                  lastAuditEntryId: this.#getLastAuditEntryId(rec.entries),
                  serverState: undefined,
                });
                if (!branchOnlySuccessIds.has(colName)) branchOnlySuccessIds.set(colName, []);
                branchOnlySuccessIds.get(colName)!.push(recordId);
              } else {
                this.#logger.error('[SR] ORPHAN: record has no server state and is not a client Created or Deleted — skipping', {
                  srId, collectionName: colName, recordId, clientEntryTypes: strippedEntries.map(e => e.type),
                });
              }
              continue;
            }
            mergedEntries = strippedEntries;
          } else {
            try {
              const serverAuditOf = { id: recordId, entries: serverState.audit as AuditEntry[] };
              const clientAuditOf = { id: recordId, entries: strippedEntries };
              const merged = auditor.merge(serverAuditOf, clientAuditOf, this.#logger);
              mergedEntries = merged.entries as AuditEntry[];
            } catch (err) {
              this.#logger.error('[SR] merge failed — skipping', {
                srId, collectionName: colName, recordId,
                serverEntries: serverState.audit.length, clientEntries: strippedEntries.length,
                error: err instanceof Error ? err.message : String(err),
              });
              continue;
            }
          }

          let liveRecord: MXDBRecord | undefined;
          try {
            const { live } = replayHistoryEndState(mergedEntries, undefined, this.#logger);
            liveRecord = live;
          } catch (err) {
            this.#logger.error('[SR] replay failed — skipping', {
              srId, collectionName: colName, recordId, mergedEntries: mergedEntries.length,
              error: err instanceof Error ? err.message : String(err),
            });
            continue;
          }

          pendingPersist.push({ collectionName: colName, recordId, mergedEntries, liveRecord, clientHash: rec.hash });
        }
      }

      const mergeMs = Math.round(performance.now() - mergeT0);

      // Step 5: Persist merged results via onUpdate.
      const persistT0 = performance.now();
      const persistByCollection = new Map<string, (MXDBActiveRecordState | MXDBDeletedRecordState)[]>();
      // Where each item's state sits, so it can be read back after `onUpdate` (which may replace it).
      const persistPositions: { item: PendingPersistItem; states: (MXDBActiveRecordState | MXDBDeletedRecordState)[]; index: number }[] = [];
      for (const item of pendingPersist) {
        if (!persistByCollection.has(item.collectionName)) persistByCollection.set(item.collectionName, []);
        const states = persistByCollection.get(item.collectionName)!;
        const state = item.liveRecord != null
          ? { record: item.liveRecord, audit: item.mergedEntries } as MXDBActiveRecordState
          : { recordId: item.recordId, audit: item.mergedEntries } as MXDBDeletedRecordState;
        persistPositions.push({ item, states, index: states.length });
        states.push(state);
      }
      const persistStates: MXDBRecordStates = [];
      for (const [colName, records] of persistByCollection) persistStates.push({ collectionName: colName, records });

      let updateResponse: MXDBSyncEngineResponse = [];
      if (persistStates.length > 0) updateResponse = await this.#props.onUpdate(persistStates);
      const persistMs = Math.round(performance.now() - persistT0);

      // `onUpdate` may amend or replace a state before persisting it (server before-write hooks amending
      // a record, or reverting a rejected one): what it persisted — not what was merged — is what the
      // client must converge to, so read the states back.
      for (const { item, states, index } of persistPositions) {
        const state = states[index]!;
        item.liveRecord = isActiveRecordState(state) ? state.record : undefined;
        item.mergedEntries = state.audit;
      }

      const persistSuccessMap = new Map<string, Set<string>>();
      for (const item of updateResponse) persistSuccessMap.set(item.collectionName, new Set(item.successfulRecordIds));

      // Step 6: Collect successful record ids for the response.
      const successResponse: MXDBSyncEngineResponse = [];
      for (const [colName, ids] of persistSuccessMap) {
        successResponse.push({ collectionName: colName, successfulRecordIds: [...ids] });
      }
      // Pass through the records `onUpdate` reports as rejected, so the client can tell the app why.
      for (const { collectionName, rejectedRecords } of updateResponse) {
        if (rejectedRecords == null || rejectedRecords.length === 0) continue;
        const existing = successResponse.find(r => r.collectionName === collectionName);
        if (existing != null) existing.rejectedRecords = [...(existing.rejectedRecords ?? []), ...rejectedRecords];
      }
      for (const [colName, ids] of branchOnlySuccessIds) {
        const existing = successResponse.find(r => r.collectionName === colName);
        if (existing) existing.successfulRecordIds.push(...ids);
        else successResponse.push({ collectionName: colName, successfulRecordIds: [...ids] });
      }

      // Step 7: Build disparity push payload — both branched-only and persisted.
      const disparityT0 = performance.now();
      const pushPayload: MXDBRecordCursors = [];
      const ensureCol = (colName: string) => {
        let col = pushPayload.find(p => p.collectionName === colName);
        if (col == null) { col = { collectionName: colName, records: [] }; pushPayload.push(col); }
        return col;
      };

      // Parallelise hashRecord across all records that need hashing — this is
      // pure CPU work per record but JS scheduling lets us batch them so we don't
      // pay the per-await microtask cost sequentially for large batches.
      const branchedActive = branchOnlyDisparities.filter(d => d.serverState != null && isActiveRecordState(d.serverState!));
      const persistedActive = pendingPersist.filter(item => {
        const successIds = persistSuccessMap.get(item.collectionName) ?? new Set();
        return successIds.has(item.recordId) && item.liveRecord != null;
      });

      const [branchedHashes, persistedHashes] = await Promise.all([
        Promise.all(branchedActive.map(d => hashRecord((d.serverState as MXDBActiveRecordState).record))),
        Promise.all(persistedActive.map(item => hashRecord(item.liveRecord!))),
      ]);

      const branchedHashByIdx = new Map<number, string>();
      branchedActive.forEach((_, i) => branchedHashByIdx.set(i, branchedHashes[i]!));
      const persistedHashByKey = new Map<string, string>();
      persistedActive.forEach((item, i) => persistedHashByKey.set(`${item.collectionName}::${item.recordId}`, persistedHashes[i]!));

      // Branched-only disparities (and server-missing ghosts — branched or updated records with no server state).
      let branchedActiveIdx = 0;
      for (const d of branchOnlyDisparities) {
        if (d.serverState == null) {
          // Server has no record or audit tombstone. Only push a delete when the client still
          // considers the record active — never for client Created records (handled above).
          if (d.clientHash == null) continue;
          const cursor: MXDBDeletedRecordCursor = { recordId: d.recordId, lastAuditEntryId: d.lastAuditEntryId };
          ensureCol(d.collectionName).records.push(cursor);
          continue;
        }
        if (isActiveRecordState(d.serverState)) {
          const serverHash = branchedHashByIdx.get(branchedActiveIdx++)!;
          if (serverHash === d.clientHash) continue; // already consistent
          const serverLastId = this.#getLastAuditEntryId(d.serverState.audit);
          const cursor: MXDBActiveRecordCursor & { hash: string } = {
            record: d.serverState.record,
            lastAuditEntryId: serverLastId,
            hash: serverHash,
          };
          ensureCol(d.collectionName).records.push(cursor);
        } else {
          // Server is deleted. If the client still thinks it's active, deliver the delete.
          if (d.clientHash == null) continue; // client already knows it's deleted
          const serverLastId = this.#getLastAuditEntryId(d.serverState.audit);
          const cursor: MXDBDeletedRecordCursor = { recordId: d.recordId, lastAuditEntryId: serverLastId };
          ensureCol(d.collectionName).records.push(cursor);
        }
      }

      // Persisted-record disparities
      for (const item of pendingPersist) {
        const colName = item.collectionName;
        const successIds = persistSuccessMap.get(colName) ?? new Set();
        if (!successIds.has(item.recordId)) continue;

        const lastAuditEntryId = this.#getLastAuditEntryId(item.mergedEntries);

        if (item.liveRecord != null) {
          const mergedHash = persistedHashByKey.get(`${colName}::${item.recordId}`)!;
          if (mergedHash === item.clientHash) continue; // client already matches the merged state
          const cursor: MXDBActiveRecordCursor & { hash: string } = {
            record: item.liveRecord,
            lastAuditEntryId,
            hash: mergedHash,
          };
          ensureCol(colName).records.push(cursor);
        } else {
          // Merged result is a delete. If the client still thought it was active, deliver the delete.
          if (item.clientHash == null) continue;
          const cursor: MXDBDeletedRecordCursor = { recordId: item.recordId, lastAuditEntryId };
          ensureCol(colName).records.push(cursor);
        }
      }

      if (pushPayload.length > 0) {
        serverDispatcher.push(pushPayload);
      }

      const disparityMs = Math.round(performance.now() - disparityT0);
      const totalMs = Math.round(performance.now() - processT0);
      const pushedRecords = pushPayload.reduce((a, c) => a + c.records.length, 0);
      const timings = { srId, records: totalRecords, totalMs, mirrorMs, retrieveMs, mergeMs, persistMs, disparityMs, pushedRecords };
      if (totalMs >= 2000) this.#logger.warn('[SR] slow process', timings);

      return successResponse;

    } catch (err) {
      // Log at debug; the caller (clientToServerSyncAction) owns the decision of whether
      // this is an error or an expected transient failure (e.g. Mongo client close during
      // a mid-test server restart), so we avoid a double-error log here.
      this.#logger.debug('[SR] process threw — SD will be resumed', { srId, error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      // Step 8: Resume the SD unconditionally.
      serverDispatcher.resume();
    }
  }

  /**
   * Build `ServerDispatcherFilter[]` from the client's claimed state. Runs
   * synchronously so it can be applied before any await inside `process`.
   */
  #buildMirrorFilter(request: ClientDispatcherRequest): ServerDispatcherFilter[] {
    const byCollection = new Map<string, ServerDispatcherFilter>();
    for (const item of request) {
      const colName = item.collectionName;
      if (!byCollection.has(colName)) {
        byCollection.set(colName, { collectionName: colName, records: [], deletedRecordIds: [] });
      }
      const filterItem = byCollection.get(colName)!;

      for (const rec of item.records) {
        const lastAuditEntryId = this.#getLastAuditEntryId(rec.entries);
        if (rec.hash != null) {
          // Client reports an active record at this hash + ULID.
          filterItem.records.push({ id: rec.id, hash: rec.hash, lastAuditEntryId });
        } else {
          // Client is deleting. Register as a pending/confirmed delete in the filter.
          filterItem.deletedRecordIds!.push(rec.id);
        }
      }
    }
    return [...byCollection.values()];
  }

  #getLastAuditEntryId(entries: AuditEntry[]): string {
    let max = '';
    for (const e of entries) {
      if (e.id > max) max = e.id;
    }
    return max;
  }
}
