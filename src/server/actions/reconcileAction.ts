import { createServerActionHandler, useLogger } from '@anupheaus/nexus/server';
import { mxdbReconcileAction } from '../../common';
import { useDb, useServerToClientSynchronisation } from '../providers';
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

    const deletedIds: string[] = [];
    for (const localId of item.localIds) {
      const serverRecord = await dbCollection.get(localId);
      if (serverRecord == null) deletedIds.push(localId);
    }

    if (deletedIds.length > 0) {
      logger.debug(`Reconcile: pushing ${deletedIds.length} stale deletions for "${item.collectionName}"`);
      // Fire-and-forget: S2C wrapper enqueues delete cursors; SD dispatches asynchronously.
      void s2c.pushDeletes(item.collectionName, deletedIds).catch(
        error => logger.error(`Reconcile: pushDeletes failed for "${item.collectionName}"`, { error }),
      );
    }

    response.push({ collectionName: item.collectionName, deletedIds });
  }

  return response;
}

export const reconcileAction = createServerActionHandler(mxdbReconcileAction, handleReconcile);
