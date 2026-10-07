import { useLogger } from '@anupheaus/nexus/server';
import { createClientActionHandler } from './createClientActionHandler';
import { mxdbReconcileAction } from '../../common';
import { useDb, useServerToClientSynchronisation } from '../providers';
import { useQueryGate } from '../collections/useQueryGate';
import type { ReconcileRequest, ReconcileResponse } from '../../common/models';

export async function handleReconcile(request: ReconcileRequest): Promise<ReconcileResponse> {
  const db = useDb();
  const logger = useLogger();
  const s2c = useServerToClientSynchronisation();

  const response: ReconcileResponse = [];

  for (const item of request) {
    if (item.localIds.length === 0) continue;

    let dbCollection: ReturnType<typeof db.use>;
    try {
      dbCollection = db.use(item.collectionName);
    } catch {
      logger.warn(`Reconcile: unknown collection "${item.collectionName}" — skipping`);
      continue;
    }

    // Which of the ids the client holds are stored, and which of those it may still read (its collection's gate).
    const storedIds = await dbCollection.queryIds({ id: { $in: item.localIds } });
    const gateFilters = await useQueryGate(dbCollection.collection).getGateFilters();
    const readableIds = gateFilters == null || storedIds.length === 0 ? storedIds : await dbCollection.queryIds({ $and: [{ id: { $in: storedIds } }, gateFilters] });
    const goneIds = item.localIds.filter(id => !storedIds.includes(id));
    // Stored, but no longer the client's to hold: evicted (no tombstone). Reported exactly as a deleted record is, so the
    // answer never tells a client which of the ids it names exist outside its gate (sc-608).
    const evictedIds = storedIds.filter(id => !readableIds.includes(id));
    const deletedIds = item.localIds.filter(id => goneIds.includes(id) || evictedIds.includes(id));

    if (evictedIds.length > 0) s2c.pushEvictions(item.collectionName, evictedIds);
    if (goneIds.length > 0) {
      logger.debug(`Reconcile: pushing ${goneIds.length} stale deletions for "${item.collectionName}"`);
      // Fire-and-forget: S2C wrapper enqueues delete cursors; SD dispatches asynchronously.
      void s2c.pushDeletes(item.collectionName, goneIds).catch(
        error => logger.error(`Reconcile: pushDeletes failed for "${item.collectionName}"`, { error }),
      );
    }

    response.push({ collectionName: item.collectionName, deletedIds });
  }

  return response;
}

export const reconcileAction = createClientActionHandler(mxdbReconcileAction, handleReconcile);
