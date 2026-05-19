import { createServerActionHandler } from '@anupheaus/nexus/server';
import { useLogger } from '@anupheaus/nexus/server';
import type { Record as MXDBRecord } from '@anupheaus/common';
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
} from '../../common/sync-engine';
import { auditor, AuditEntryType } from '../../common';
import type { AnyAuditOf, AuditOf } from '../../common';
import { isActiveRecordState } from '../../common/sync-engine';
import { isTransientMongoCloseError } from '../utils/isTransientMongoCloseError';

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

function withRecordLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
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
 * Client-to-Server sync handler.
 *
 * Thin wrapper around {@link ServerReceiver}. The SR handles merge, replay,
 * delete-is-final enforcement, and post-merge SD push orchestration. This
 * handler plumbs `onRetrieve` (read current server audits) and `onUpdate`
 * (persist merged audits + materialised records via `ServerDbCollection.sync`).
 */
export const clientToServerSyncAction = createServerActionHandler(
  mxdbClientToServerSyncAction,
  async (request: ClientDispatcherRequest): Promise<MXDBSyncEngineResponse> => {
    const db = useDb();
    const logger = useLogger();
    const s2c = useServerToClientSynchronisation();

    if (s2c.isNoOp) {
      logger.warn('C2S sync handler invoked under no-op S2C instance — skipping');
      return [];
    }

    const sr = new ServerReceiver(logger.createSubLogger('sr'), {
      serverDispatcher: s2c.dispatcher,

      onRetrieve: async (retrieveRequest: MXDBRecordStatesRequest): Promise<MXDBRecordStates> => {
        const retrieveT0 = performance.now();
        const out: MXDBRecordStates = [];
        // Bulk-fetch per collection: ONE audit query + ONE live-record query per collection
        // instead of 2×N sequential round trips.
        await Promise.all(retrieveRequest.map(async item => {
          let collection: ReturnType<typeof db.use>;
          try { collection = db.use(item.collectionName); }
          catch {
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
          const liveById = new Map<string, MXDBRecord>(liveRecords.map((r: MXDBRecord) => [r.id, r] as [string, MXDBRecord]));
          const records: (MXDBActiveRecordState | MXDBDeletedRecordState)[] = [];
          for (const serverAudit of audits) {
            if (serverAudit == null) continue;
            const recordId = (serverAudit as AnyAuditOf<MXDBRecord>).id;
            const entries = auditor.entriesOf(serverAudit as AnyAuditOf<MXDBRecord>);
            if (auditor.isDeleted(serverAudit as AnyAuditOf<MXDBRecord>)) {
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
          const perColMs = Math.round(performance.now() - perColT0);
          logger.debug('[C2S] retrieve', { collection: item.collectionName, requested: item.recordIds.length, audits: audits.length, live: liveRecords.length, returned: records.length, ms: perColMs });
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
          let collection: ReturnType<typeof db.use>;
          try { collection = db.use(col.collectionName); }
          catch {
            logger.warn(`C2S onUpdate: unknown collection "${col.collectionName}" — skipping`);
            continue;
          }

          const updated: MXDBRecord[] = [];
          const removedIds: string[] = [];
          const updatedAudits: AnyAuditOf<MXDBRecord>[] = [];
          const attempted: string[] = [];

          for (const state of col.records) {
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

          try {
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
            const successfulRecordIds = attempted.filter(id => !failedIds.has(id));
            response.push({ collectionName: col.collectionName, successfulRecordIds });
          } catch (error) {
            if (isTransientMongoCloseError(error)) {
              logger.warn(`C2S onUpdate aborted by client close (shutdown race) for "${col.collectionName}"`, { error });
            } else {
              logger.error(`C2S onUpdate failed for "${col.collectionName}"`, { error });
            }
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

    // Log incoming record ids + entry types at the socket boundary for tracing.
    for (const col of request) {
      for (const rec of col.records) {
        const entryTypes = rec.entries.map(e => `${e.type}:${e.id}`).join(',');
        logger.debug(`[C2S-IN] "${col.collectionName}" recId=${rec.id} hash=${rec.hash ?? 'null'} entries=[${entryTypes}]`);
      }
    }

    try {
      return await withRecordLocks(lockKeys, () => sr.process(request));
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
  },
);
