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
  type MXDBReadableRecords,
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
  /**
   * The server's read gate (the collection's `onQuery`), as a read: of the given record ids, the live records this
   * client may read, read through the gate in ONE query. Called after persisting, so a record the client just wrote is
   * judged as it is now stored. A record it does not return is answered only with an eviction (never its content,
   * never a plain delete) and is removed from the dispatcher's filter, so a client claiming an id it may not read is
   * not subscribed to its changes. Content is sent only when it is the version the gate passed: a record that changed
   * after the receiver read it is left to the change stream, which reads it through the gate again (sc-682).
   * Absent: every record is readable.
   */
  onReadReadable?(request: MXDBRecordStatesRequest): Promise<MXDBReadableRecords>;
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
 * 4b. Read gate: read the request's records this client may read ({@link ServerReceiverProps.onReadReadable}).
 *    A record outside it gets only an eviction (if the client claimed it), and is removed from the SD filter the mirror seeded.
 * 5. All disparity pushes go through `sd.push(payload)` with the default
 *    `addToFilter=true`. Since the mirror set in step 2 has the client's old
 *    hash and the cursor carries the new (server/merged) hash, the SD's filter
 *    check picks them up as mismatches and dispatches them.
 * 6. Resume the SD.
 */
let srIdCounter = 0;

/** What the read gate returned for a sync request: the readable records by collection and id, and the ungated collections. */
interface ReadableRecords {
  byCollection: Map<string, Map<string, MXDBRecord>>;
  ungatedCollections: Set<string>;
}

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

    // The mirror (step 2) subscribes the client to every id it CLAIMS. Until the read gate has vetted those claims
    // (step 5b), a throw — even one while mirroring — must not leave an unvetted one in the filter: fail closed
    // (see the `finally`). Pause and mirror sit inside the `try` so that `finally` always covers them.
    let areClaimsVetted = this.#props.onReadReadable == null;
    let mirrorMs = 0;

    try {
      // Step 1: Pause the SD so queued/pending dispatches hold until we finish (resumed in the `finally`).
      serverDispatcher.pause();

      // Step 2: Synchronously mirror the client's claimed state into #filter.
      // MUST happen before any await — any change-stream event that races with
      // this C2S call will be evaluated against this mirror when we resume.
      const mirrorFilters = this.#buildMirrorFilter(request);
      if (mirrorFilters.length > 0) serverDispatcher.updateFilter(mirrorFilters);
      mirrorMs = Math.round(performance.now() - processT0);

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

      // Step 5b: the read gate, judged on what is now stored. A client can name any id in a sync request; it
      // must not be answered with, or subscribed to, a record it may not read.
      // The gate and the content are one read: content is only sent when it is the version the gate passed.
      const readableRecords = await this.#readReadable(request);
      const isGated = (collectionName: string): boolean => readableRecords != null && !readableRecords.ungatedCollections.has(collectionName);
      const isReadable = (collectionName: string, recordId: string): boolean => !isGated(collectionName) || readableRecords?.byCollection.get(collectionName)?.has(recordId) === true;
      const unreadable: MXDBRecordStatesRequest = request
        .map(({ collectionName, records }) => ({ collectionName, recordIds: records.map(({ id }) => id).filter(id => !isReadable(collectionName, id)) }))
        .filter(({ recordIds }) => recordIds.length > 0);
      if (unreadable.length > 0) serverDispatcher.removeFromFilter(unreadable);
      areClaimsVetted = true;

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
      // A record outside the read gate is answered only with an EVICTION — never its content, and never a plain delete —
      // whether it is live, deleted or was never stored: the client drops its copy (without a tombstone), and cannot
      // tell those cases apart. A record the server holds as a tombstone is still tombstoned in the SD, so the delete
      // stays final for this connection.
      const tombstonedUnreadable = new Map<string, string[]>();
      const evict = (collectionName: string, recordId: string, serverState: MXDBActiveRecordState | MXDBDeletedRecordState | undefined): void => {
        const cursor: MXDBDeletedRecordCursor = { recordId, lastAuditEntryId: '', isEviction: true };
        ensureCol(collectionName).records.push(cursor);
        if (serverState != null && !isActiveRecordState(serverState)) tombstonedUnreadable.set(collectionName, [...(tombstonedUnreadable.get(collectionName) ?? []), recordId]);
      };
      // Held at the server's current hash (confirmed from `_meta`), but no longer readable: e.g. the caller lost access.
      for (const [colName, ids] of metaMatched) {
        for (const id of ids) if (!isReadable(colName, id)) evict(colName, id, undefined);
      }

      // Parallelise hashRecord across all records that need hashing — this is
      // pure CPU work per record but JS scheduling lets us batch them so we don't
      // pay the per-await microtask cost sequentially for large batches.
      const branchedActive = branchOnlyDisparities.filter(d => d.serverState != null && isActiveRecordState(d.serverState!));
      const persistedActive = pendingPersist.filter(item => {
        const successIds = persistSuccessMap.get(item.collectionName) ?? new Set();
        return successIds.has(item.recordId) && item.liveRecord != null;
      });

      const [branchedHashes, persistedHashes, gatedHashes] = await Promise.all([
        Promise.all(branchedActive.map(d => hashRecord((d.serverState as MXDBActiveRecordState).record))),
        Promise.all(persistedActive.map(item => hashRecord(item.liveRecord!))),
        this.#hashGatedVersions(readableRecords, [
          ...branchedActive.map(({ collectionName, recordId }) => ({ collectionName, recordId })),
          ...persistedActive.map(({ collectionName, recordId }) => ({ collectionName, recordId })),
        ]),
      ]);
      /** Whether `hash` is the version the read gate passed (always, with no gate). */
      const isGatedVersion = (collectionName: string, recordId: string, hash: string): boolean => {
        if (gatedHashes == null || !isGated(collectionName)) return true;
        if (gatedHashes.get(`${collectionName}::${recordId}`) === hash) return true;
        this.#logger.debug('[SR] record changed after it was read — left to the change stream', { srId, collectionName, recordId });
        return false;
      };

      const branchedHashByIdx = new Map<number, string>();
      branchedActive.forEach((_, i) => branchedHashByIdx.set(i, branchedHashes[i]!));
      const persistedHashByKey = new Map<string, string>();
      persistedActive.forEach((item, i) => persistedHashByKey.set(`${item.collectionName}::${item.recordId}`, persistedHashes[i]!));

      // Branched-only disparities (and server-missing ghosts — branched or updated records with no server state).
      let branchedActiveIdx = 0;
      for (const d of branchOnlyDisparities) {
        // Consumed for every active server state, readable or not, so the index stays aligned with `branchedActive`.
        const serverHash = d.serverState != null && isActiveRecordState(d.serverState) ? branchedHashByIdx.get(branchedActiveIdx++)! : undefined;
        if (!isReadable(d.collectionName, d.recordId)) {
          if (d.clientHash != null) evict(d.collectionName, d.recordId, d.serverState);
          continue;
        }
        if (d.serverState == null) {
          // Server has no record or audit tombstone. Only push a delete when the client still
          // considers the record active — never for client Created records (handled above).
          if (d.clientHash == null) continue;
          const cursor: MXDBDeletedRecordCursor = { recordId: d.recordId, lastAuditEntryId: d.lastAuditEntryId };
          ensureCol(d.collectionName).records.push(cursor);
          continue;
        }
        if (isActiveRecordState(d.serverState)) {
          if (serverHash === d.clientHash) continue; // already consistent
          if (!isGatedVersion(d.collectionName, d.recordId, serverHash!)) continue;
          const serverLastId = this.#getLastAuditEntryId(d.serverState.audit);
          const cursor: MXDBActiveRecordCursor & { hash: string } = {
            record: d.serverState.record,
            lastAuditEntryId: serverLastId,
            hash: serverHash!,
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

        if (!isReadable(colName, item.recordId)) {
          // E.g. a change the write gate refused (its state is what the server holds): the device drops its local edit
          // rather than keep a version the server does not have.
          if (item.liveRecord != null || item.clientHash != null) {
            evict(colName, item.recordId, item.liveRecord != null ? { record: item.liveRecord, audit: item.mergedEntries } : { recordId: item.recordId, audit: item.mergedEntries });
          }
          continue;
        }

        if (item.liveRecord != null) {
          const mergedHash = persistedHashByKey.get(`${colName}::${item.recordId}`)!;
          if (mergedHash === item.clientHash) continue; // client already matches the merged state
          if (!isGatedVersion(colName, item.recordId, mergedHash)) continue;
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

      if (tombstonedUnreadable.size > 0) {
        serverDispatcher.updateFilter([...tombstonedUnreadable].map(([collectionName, deletedRecordIds]) => ({ collectionName, records: [], deletedRecordIds })));
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
      // Fail closed: forget every claim of this request. The client resends them on its retry and they are
      // mirrored (and vetted) again then; meanwhile a claim cannot pull an unreadable record's changes.
      try {
        if (!areClaimsVetted) serverDispatcher.removeFromFilter(this.#claimedIds(request));
      } finally {
        // Step 8: Resume the SD unconditionally.
        serverDispatcher.resume();
      }
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

  /** Every record id `request` names, per collection. */
  #claimedIds(request: ClientDispatcherRequest): MXDBRecordStatesRequest {
    // Tolerant of a malformed request (this runs in the `finally`): only string ids can have reached the filter.
    return request.map(({ collectionName, records }) => ({ collectionName, recordIds: (Array.isArray(records) ? records : []).map(record => record?.id).filter((id): id is string => typeof id === 'string') }));
  }

  /**
   * The records per collection (by id) this client may read, and the collections with no gate (every id readable), or
   * `undefined` when the server supplies no read gate. A collection the read does not answer for is gated: fail closed.
   */
  async #readReadable(request: ClientDispatcherRequest): Promise<ReadableRecords | undefined> {
    const { onReadReadable } = this.#props;
    if (onReadReadable == null) return undefined;
    const recordsRequest: MXDBRecordStatesRequest = request
      .map(({ collectionName, records }) => ({ collectionName, recordIds: [...new Set(records.map(({ id }) => id))] }))
      .filter(({ recordIds }) => recordIds.length > 0);
    const readable: ReadableRecords = { byCollection: new Map(), ungatedCollections: new Set() };
    if (recordsRequest.length === 0) return readable;
    for (const { collectionName, records, isGated } of await onReadReadable(recordsRequest)) {
      if (!isGated) readable.ungatedCollections.add(collectionName);
      const byId = readable.byCollection.get(collectionName) ?? new Map<string, MXDBRecord>();
      for (const record of records) byId.set(record.id, record);
      readable.byCollection.set(collectionName, byId);
    }
    return readable;
  }

  /** The hash of the version the read gate passed, keyed `collection::id`, for the given records it passed; `undefined` with no gate. */
  async #hashGatedVersions(readable: ReadableRecords | undefined, candidates: { collectionName: string; recordId: string }[]): Promise<Map<string, string> | undefined> {
    if (readable == null) return undefined;
    const hashes = new Map<string, string>();
    await Promise.all(candidates.map(async ({ collectionName, recordId }) => {
      const record = readable.byCollection.get(collectionName)?.get(recordId);
      if (record != null) hashes.set(`${collectionName}::${recordId}`, await hashRecord(record));
    }));
    return hashes;
  }

  #getLastAuditEntryId(entries: AuditEntry[]): string {
    let max = '';
    for (const e of entries) {
      if (e.id > max) max = e.id;
    }
    return max;
  }
}
