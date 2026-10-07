import { useLogger } from '@anupheaus/nexus/server';
import type { Record as MXDBRecord } from '@anupheaus/common';
import { createClientActionHandler } from './createClientActionHandler';
import { mxdbClientToServerSyncAction } from '../../common/internalActions';
import { useDb, useServerToClientSynchronisation } from '../providers';
import {
  ServerReceiver,
  type ClientDispatcherRequest,
  type MXDBRecordStates,
  type MXDBRecordStatesRequest,
  type MXDBSyncEngineResponse,
  type MXDBActiveRecordState,
  type MXDBDeletedRecordState,
  type MXDBRecordMetas,
} from '../../common/sync-engine';
import { auditor, AuditEntryType } from '../../common';
import type { AnyAuditOf, AuditOf } from '../../common';
import { isActiveRecordState } from '../../common/sync-engine';
import { isTransientMongoCloseError } from '../utils/isTransientMongoCloseError';
import { runBeforeWriteHooksOnSyncStates } from './runBeforeWriteHooksOnSyncStates';
import { readReadableRecords } from './readReadableRecords';
import { rejectWritesOutsideReadGate } from './rejectWritesOutsideReadGate';
import { assertValidSyncRequest } from './assertValidSyncRequest';
import { hasConcurrentServerChange } from './hasConcurrentServerChange';
import { buildC2SSyncSummary, C2S_SYNC_SUMMARY_MESSAGE, type C2SSyncCollectionResult } from './buildC2SSyncSummary';

/**
 * Per-record promise chain — serialises concurrent C2S syncs for the same record across clients.
 *
 * The ServerReceiver performs a read-merge-write cycle that is NOT atomic against Mongo:
 * `onRetrieve` reads the server audit outside a transaction, merges in the client's pending
 * entries, then `onUpdate` replaces the audit doc via `bulkWrite({ replaceOne })`. Two
 * concurrent requests from different clients both read the same baseline, merge their own
 * entries, and the second write clobbers the first — losing audit entries.
 *
 * Serialising at the handler level (per record id) forces a happens-before order so each
 * request's read observes the previous request's write. Unrelated records are still processed
 * in parallel because the gate is keyed per record.
 */
const recordSyncGates = new Map<string, Promise<void>>();

export function withRecordLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  if (keys.length === 0) return fn();
  const priors = keys.map(k => recordSyncGates.get(k) ?? Promise.resolve());
  const release = Promise.allSettled(priors).then(fn);
  const tracked = release.then(() => { }, () => { });
  for (const k of keys) recordSyncGates.set(k, tracked);
  // Opportunistic cleanup so the map does not grow unbounded for long-lived servers.
  tracked.then(() => {
    for (const k of keys) {
      if (recordSyncGates.get(k) === tracked) recordSyncGates.delete(k);
    }
  });
  return release;
}

/**
 * Build the server's current `MXDBRecordState`s for a collection from the batch-fetched audits and live
 * records — the data `onRetrieve` hands the {@link ServerReceiver} to decide merges and disparities.
 */
export function buildServerRecordStates(
  audits: (AnyAuditOf<MXDBRecord> | undefined)[],
  liveRecords: MXDBRecord[],
): (MXDBActiveRecordState | MXDBDeletedRecordState)[] {
  const liveById = new Map<string, MXDBRecord>(liveRecords.map(r => [r.id, r] as [string, MXDBRecord]));
  const records: (MXDBActiveRecordState | MXDBDeletedRecordState)[] = [];
  const handledIds = new Set<string>();
  for (const serverAudit of audits) {
    if (serverAudit == null) continue;
    const recordId = serverAudit.id;
    handledIds.add(recordId);
    const entries = auditor.entriesOf(serverAudit);
    if (auditor.isDeleted(serverAudit)) {
      records.push({ recordId, audit: entries });
    } else {
      const liveRecord = liveById.get(recordId);
      if (liveRecord == null) {
        // Audit exists but no live record — treat as deleted (split-brain guard).
        records.push({ recordId, audit: entries });
      } else {
        records.push({ record: liveRecord, audit: entries });
      }
    }
  }
  // Live records with NO server audit (disableAudit collections have no audit at all). Report them as
  // live with an empty audit — WITHOUT this, an audit-driven build returns no state for a record that
  // genuinely exists, and the ServerReceiver then treats the client's synced-back copy as a deleted
  // "ghost" and pushes a delete, permanently removing every disableAudit record from the client.
  for (const [recordId, liveRecord] of liveById) {
    if (handledIds.has(recordId)) continue;
    records.push({ record: liveRecord, audit: [] });
  }
  return records;
}

function stateIdOf(state: MXDBActiveRecordState | MXDBDeletedRecordState): string {
  return isActiveRecordState(state) ? state.record.id : state.recordId;
}

/**
 * Client-to-Server sync handler.
 *
 * Thin wrapper around {@link ServerReceiver}. The SR handles merge, replay,
 * delete-is-final enforcement, and post-merge SD push orchestration. This
 * handler plumbs `onRetrieve` (read current server audits) and `onUpdate`
 * (persist merged audits + materialised records via `ServerDbCollection.sync`).
 */
export async function handleClientToServerSync(request: ClientDispatcherRequest): Promise<MXDBSyncEngineResponse> {
  // Before anything is mirrored or queried: every id becomes a filter key and a MongoDB `$in` value.
  assertValidSyncRequest(request);
  const db = useDb();
  const logger = useLogger();
  const s2c = useServerToClientSynchronisation();

  if (s2c.isNoOp) {
    logger.warn('C2S sync handler invoked under no-op S2C instance — skipping');
    return [];
  }

  // What the client sent per record, to tell a conflict (a merge with a change it had not seen) from a plain write.
  const clientEntriesByKey = new Map(request.flatMap(({ collectionName, records }) => records.map(({ id, entries }) => [`${collectionName}::${id}`, entries] as const)));
  // Filled by `onUpdate`, one per collection persisted; summarised in one info entry once the sync is done.
  const collectionResults: C2SSyncCollectionResult[] = [];

  const sr = new ServerReceiver(logger.createSubLogger('sr'), {
    serverDispatcher: s2c.dispatcher,

    // The read gate: a sync request can name any record id, so the receiver answers (and subscribes the client
    // to) only the records the collection's onQuery lets this caller read (sc-583), read through the gate in one
    // query so it never sends a version other than the one the gate passed (sc-682).
    onReadReadable: readReadableRecords,

    // Meta fast-path: project stored `_meta.hash` only — no full record fetch/deserialise. The
    // ServerReceiver uses this to confirm branched-only records whose hash already matches the client,
    // skipping the expensive retrieve for the (dominant) "nothing changed" reconnect case.
    onRetrieveMeta: async (metaRequest: MXDBRecordStatesRequest): Promise<MXDBRecordMetas> => {
      const out: MXDBRecordMetas = [];
      await Promise.all(metaRequest.map(async item => {
        if (item.recordIds.length === 0) return;
        let collection: ReturnType<typeof db.use> | undefined;
        try { collection = db.use(item.collectionName); }
        catch { collection = undefined; }
        // `db.use` returns undefined (it does not throw) for a collection this server db does not
        // register — skip it; the caller falls back to full retrieve.
        if (collection == null) return;
        const metas = await collection.getMeta(item.recordIds);
        if (metas.length > 0) out.push({ collectionName: item.collectionName, records: metas });
      }));
      return out;
    },

    onRetrieve: async (retrieveRequest: MXDBRecordStatesRequest): Promise<MXDBRecordStates> => {
      const retrieveT0 = performance.now();
      const out: MXDBRecordStates = [];
      // Bulk-fetch per collection: ONE audit query + ONE live-record query per collection
      // instead of 2×N sequential round trips.
      await Promise.all(retrieveRequest.map(async item => {
        let collection: ReturnType<typeof db.use> | undefined;
        try { collection = db.use(item.collectionName); }
        catch { collection = undefined; }
        // `db.use` returns undefined (it does not throw) for an unknown collection.
        if (collection == null) {
          logger.warn('C2S onRetrieve: unknown collection — skipping', {
            collectionName: item.collectionName,
            recordCount: item.recordIds.length,
          });
          return;
        }
        if (item.recordIds.length === 0) return;
        const perColT0 = performance.now();
        // DO NOT swallow errors here — a retrieve failure is NOT "record does not exist".
        // The SR would see serverState == null and route entries into the ORPHAN-drop
        // path, silently losing client edits. Surfacing the error lets the client retry.
        const [audits, liveRecords] = await Promise.all([
          collection.getAudit(item.recordIds),
          collection.get(item.recordIds),
        ]);
        const records = buildServerRecordStates(audits as (AnyAuditOf<MXDBRecord> | undefined)[], liveRecords);
        const perColMs = Math.round(performance.now() - perColT0);
        if (perColMs >= 500) {
          logger.warn('[C2S] slow retrieve', { collection: item.collectionName, ms: perColMs, requested: item.recordIds.length });
        }
        if (records.length > 0) out.push({ collectionName: item.collectionName, records });
      }));
      const retrieveMs = Math.round(performance.now() - retrieveT0);
      if (retrieveMs >= 1000) {
        const totalIds = retrieveRequest.reduce((acc, it) => acc + it.recordIds.length, 0);
        logger.warn('[C2S] slow retrieve total', { ms: retrieveMs, collections: retrieveRequest.length, totalIds });
      }
      return out;
    },

    onUpdate: async (records: MXDBRecordStates): Promise<MXDBSyncEngineResponse> => {
      const response: MXDBSyncEngineResponse = [];
      for (const col of records) {
        let collection: ReturnType<typeof db.use> | undefined;
        try { collection = db.use(col.collectionName); }
        catch { collection = undefined; }
        // `db.use` returns undefined (it does not throw) for an unknown collection.
        if (collection == null) {
          logger.warn(`C2S onUpdate: unknown collection "${col.collectionName}" — skipping`);
          continue;
        }

        // Judged before the hooks run: a hook's amendment is the server's own change, not a conflict.
        const conflictedIds = new Set(col.records
          .filter(state => hasConcurrentServerChange({ clientEntries: clientEntriesByKey.get(`${col.collectionName}::${stateIdOf(state)}`) ?? [], mergedEntries: state.audit }))
          .map(stateIdOf));

        try {
          // First the read gate: an update or delete to a record whose stored version the caller may not read is
          // refused outright (sc-583). Then the before-write hooks, which may amend or revert the remaining states
          // in place; the receiver reads them back to push what was persisted to the client. A rejected record is
          // still acknowledged (so the client stops resending it) and reported back with the reason.
          const outsideGate = await rejectWritesOutsideReadGate({ collection, states: col.records });
          // The cause is logged here only: the client is told the same thing whatever it was (sc-998).
          for (const { id, cause } of outsideGate.refusedWrites) {
            logger.warn('C2S write refused: the caller may not read the stored record (outside its read gate, or deleted)', { collectionName: col.collectionName, recordId: id, cause });
          }
          const hooked = await runBeforeWriteHooksOnSyncStates({ collection, states: col.records, excludedIds: new Set(outsideGate.unpersistedIds) });
          for (const { id, reason, kind } of hooked.rejectedRecords) {
            logger.warn('C2S write rejected by a before-write hook — reverting it on the client', { collectionName: col.collectionName, recordId: id, reason, kind });
          }
          for (const { id, note } of hooked.amendedRecords) {
            logger.info('C2S write amended by a before-write hook — telling the client what was put back', { collectionName: col.collectionName, recordId: id, note });
          }
          const rejectedRecords = [...outsideGate.rejectedRecords, ...hooked.rejectedRecords];
          const unpersistedIds = [...outsideGate.unpersistedIds, ...hooked.unpersistedIds];
          const unpersisted = new Set(unpersistedIds);

          const updated: MXDBRecord[] = [];
          const removedIds: string[] = [];
          const updatedAudits: AnyAuditOf<MXDBRecord>[] = [];
          const attempted: string[] = [];

          for (const state of col.records) {
            if (unpersisted.has(isActiveRecordState(state) ? state.record.id : state.recordId)) continue;
            if (isActiveRecordState(state)) {
              updated.push(state.record);
              updatedAudits.push({ id: state.record.id, entries: state.audit } as AuditOf<MXDBRecord>);
              attempted.push(state.record.id);
            } else {
              removedIds.push(state.recordId);
              updatedAudits.push({ id: state.recordId, entries: state.audit } as AuditOf<MXDBRecord>);
              attempted.push(state.recordId);
            }
          }

          const writeResults = await collection.sync({ updated, updatedAudits, removedIds });
          const failedIds = new Set<string>();
          for (const wr of writeResults) {
            if (wr.error != null) {
              if (isTransientMongoCloseError(wr.error)) {
                logger.warn(`C2S transient close failure for record "${wr.id}" (shutdown race)`, { error: wr.error });
              } else {
                logger.error(`C2S permanent I/O failure for record "${wr.id}"`, { error: wr.error });
              }
              failedIds.add(wr.id);
            }
          }
          // A record that failed to persist is retried, so its note is held back until the write that does succeed.
          const amendedRecords = hooked.amendedRecords.filter(({ id }) => !failedIds.has(id));
          const successfulRecordIds = [...attempted.filter(id => !failedIds.has(id)), ...unpersistedIds];
          // A rejected create or update is still written (reverted), but that is the server undoing it, not a client write.
          const rejectedIds = new Set(rejectedRecords.map(({ id }) => id));
          const isClientWrite = (id: string): boolean => !failedIds.has(id) && !rejectedIds.has(id);
          const upsertedIds = updated.map(({ id }) => id).filter(isClientWrite);
          const deletedIds = removedIds.filter(isClientWrite);
          // Ids and counts only: never record values (see the logging rules on epic 373).
          if (upsertedIds.length > 0) logger.debug('C2S write', { collectionName: col.collectionName, op: 'upsert', count: upsertedIds.length, recordIds: upsertedIds });
          if (deletedIds.length > 0) logger.debug('C2S write', { collectionName: col.collectionName, op: 'delete', count: deletedIds.length, recordIds: deletedIds });
          collectionResults.push({
            collectionName: col.collectionName,
            upserted: upsertedIds.length,
            deleted: deletedIds.length,
            conflicts: [...upsertedIds, ...deletedIds].filter(id => conflictedIds.has(id)).length,
            rejected: rejectedRecords.length,
            failed: failedIds.size,
          });
          response.push({ collectionName: col.collectionName, successfulRecordIds, ...(rejectedRecords.length > 0 ? { rejectedRecords } : {}), ...(amendedRecords.length > 0 ? { amendedRecords } : {}) });
        } catch (error) {
          if (isTransientMongoCloseError(error)) {
            logger.warn(`C2S onUpdate aborted by client close (shutdown race) for "${col.collectionName}"`, { error });
          } else {
            logger.error(`C2S onUpdate failed for "${col.collectionName}"`, { error });
          }
          collectionResults.push({ collectionName: col.collectionName, upserted: 0, deleted: 0, conflicts: 0, rejected: 0, failed: col.records.length });
          response.push({ collectionName: col.collectionName, successfulRecordIds: [] });
        }
      }
      return response;
    },
  });

  // Only lock records whose client entries contain a non-Branched entry — those
  // are the ones the SR will actually merge + persist. Branched-only records are
  // pure disparity probes (retrieve + hash compare, no audit mutation), so they
  // do not need the per-record serialisation gate. This matters at reconnect
  // scale: the CD onStart sweep now sends every locally known record, which for
  // a typical client is 95%+ branchOnly. Locking them all turns N concurrent
  // client reconnects into an N-deep serial chain on the shared record ids.
  const lockKeys: string[] = [];
  for (const col of request) {
    for (const rec of col.records) {
      const hasMergeableEntry = rec.entries.some(e => e.type !== AuditEntryType.Branched);
      if (hasMergeableEntry) lockKeys.push(`${col.collectionName}::${rec.id}`);
    }
  }

  try {
    const response = await withRecordLocks(lockKeys, () => sr.process(request));
    const summary = buildC2SSyncSummary(collectionResults);
    if (summary != null) logger.info(C2S_SYNC_SUMMARY_MESSAGE, summary);
    return response;
  } catch (error) {
    if (isTransientMongoCloseError(error)) {
      // Expected during server restart / teardown — the in-flight Mongo op was aborted.
      // Return an empty response (no successful ids) so the client retries on its next
      // sync tick without surfacing an action-level error. Downgrade so
      // getAppLoggerErrorCount() does not trip on shutdown noise in the stress test.
      logger.warn('C2S sync process aborted by client close (shutdown race) — returning empty response', { error });
      return [];
    }
    logger.error('C2S sync process failed', { error });
    throw error;
  }
}

export const clientToServerSyncAction = createClientActionHandler(mxdbClientToServerSyncAction, handleClientToServerSync);
