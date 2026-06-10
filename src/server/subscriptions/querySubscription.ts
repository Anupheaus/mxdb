import type { Record } from '@anupheaus/common';
import { mxdbQuerySubscription } from '../../common';
import { getCollectionExtensions, useCollection } from '../collections';
import { useDb, useServerToClientSynchronisation } from '../providers';
import { createServerCollectionSubscription } from './createServerCollectionSubscription';
import { pushSubscriptionResultRecords } from './pushSubscriptionResultRecords';
import { useAuthentication, useLogger } from '@anupheaus/nexus/server';
import type { QueryProps } from '../../common';

export const serverQuerySubscription = createServerCollectionSubscription<string[]>()(mxdbQuerySubscription,
  async ({ request, previousResponse, subscriptionId, additionalData: previousRecordIds, updateAdditionalData, update, onUnsubscribe }) => {
    const logger = useLogger();
    const { collectionName, filters, pagination, sorts, serverHints, getAccurateTotal } = request;
    const { collection, query, onChange, removeOnChange } = useCollection(collectionName);
    // Capture at subscription-setup time. onChange callbacks fire from the MongoDB change stream
    // outside any ALS context, so a late useServerToClientSynchronisation() would fall back to the no-op.
    const capturedS2C = useServerToClientSynchronisation();

    // Apply onQuery extension hook for server-side security filtering
    const db = useDb();
    const dbCollection = db.use(collectionName);
    const extensions = dbCollection.collection != null ? getCollectionExtensions(dbCollection.collection) : undefined;
    let baseRequest: QueryProps<Record> = { filters, pagination, sorts, serverHints, getAccurateTotal };
    if (extensions?.onQuery != null) {
      const userId = (() => { try { return useAuthentication().user?.id; } catch { return undefined; } })();
      const modified = await extensions.onQuery({ request: baseRequest, userId });
      if (modified != null) baseRequest = modified;
    }
    const {
      filters: effectiveFilters,
      pagination: effectivePagination,
      sorts: effectiveSorts,
      serverHints: _effectiveHints,
      getAccurateTotal: effectiveGetAccurateTotal,
    } = baseRequest;

    const runQuery = () => query({
      filters: effectiveFilters as any,
      pagination: effectivePagination,
      sorts: effectiveSorts as any,
      getAccurateTotal: effectiveGetAccurateTotal ?? true,
    });

    async function refreshQueryAndPushToSubscriber(): Promise<[string[], number]> {
      const { data: records, total } = await runQuery();
      await pushSubscriptionResultRecords(capturedS2C, collection, records, []);
      return [records.ids(), total];
    }

    const watchId = `mxdb.query.${subscriptionId}`;
    onChange(watchId, async () => {
      try {
        const [newRecordIds, newTotal] = await refreshQueryAndPushToSubscriber();
        // if the new total is different or we have different number of record ids, we need to update
        if (newTotal !== previousResponse || newRecordIds.length !== previousRecordIds?.length) { return update(newTotal); }
        // if the record is new or should now appear in this query or has changed place, we need to update
        if (previousRecordIds.some((id, index) => newRecordIds[index] !== id)) { return update(newTotal); }
      } catch (err) {
        logger.error('querySubscription onChange error', {
          collectionName, subscriptionId,
          previousRecordCount: previousRecordIds?.length ?? 0,
          capturedS2CIsNoOp: capturedS2C.isNoOp,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    onUnsubscribe(() => removeOnChange(watchId));

    try {
      const [recordIds, total] = await refreshQueryAndPushToSubscriber();
      updateAdditionalData(recordIds);
      return total;
    } catch (err) {
      logger.error('querySubscription setup error (initial push failed)', {
        collectionName, subscriptionId,
        hasFilters: filters != null && Object.keys(filters).length > 0,
        capturedS2CIsNoOp: capturedS2C.isNoOp,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });
