import type { Record } from '@anupheaus/common';
import { mxdbQuerySubscription } from '../../common';
import { useCollection } from '../collections';
import { useQueryGate } from '../collections/useQueryGate';
import { useServerToClientSynchronisation } from '../providers';
import { createServerCollectionSubscription } from './createServerCollectionSubscription';
import { pushSubscriptionResultRecords } from './pushSubscriptionResultRecords';
import { useLogger } from '@anupheaus/nexus/server';

export const serverQuerySubscription = createServerCollectionSubscription<string[]>()(mxdbQuerySubscription,
  async ({ request, subscriptionId, updateAdditionalData, update, onUnsubscribe }) => {
    const logger = useLogger();
    const { collectionName, filters, pagination, sorts, serverHints, getAccurateTotal } = request;
    const { collection, query, onChange, removeOnChange } = useCollection(collectionName);
    // Capture at subscription-setup time. onChange callbacks fire from the MongoDB change stream
    // outside any ALS context, so a late useServerToClientSynchronisation() would fall back to the no-op.
    const capturedS2C = useServerToClientSynchronisation();

    // The collection's gate (server-side security scoping), resolved once, now: the change handler runs from the
    // change stream, outside this request, where the caller the gate scopes to can no longer be read.
    const baseRequest = await useQueryGate<Record>(collection).gateRequest({ filters, pagination, sorts, serverHints, getAccurateTotal });
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

    // What the client currently holds: the initial response, then each update sent since. Changes are
    // compared against this — not the response/ids remembered from an earlier subscribe, which this
    // subscribe's fresh initial response has already superseded on the client.
    let sentTotal: number | undefined;
    let sentRecordIds: string[] = [];

    function rememberSentResult(recordIds: string[], total: number): void {
      sentTotal = total;
      sentRecordIds = recordIds;
      // Persisted alongside the previous response (saved by `update`) so a re-subscribe starts from them.
      updateAdditionalData(recordIds);
    }

    function hasVisiblyChanged(recordIds: string[], total: number): boolean {
      if (total !== sentTotal || recordIds.length !== sentRecordIds.length) return true;
      // a record is new, should now appear in this query, or has changed place
      return sentRecordIds.some((id, index) => recordIds[index] !== id);
    }

    const watchId = `mxdb.query.${subscriptionId}`;
    onChange(watchId, async () => {
      try {
        const [newRecordIds, newTotal] = await refreshQueryAndPushToSubscriber();
        if (!hasVisiblyChanged(newRecordIds, newTotal)) return;
        rememberSentResult(newRecordIds, newTotal);
        await update(newTotal);
      } catch (err) {
        logger.error('querySubscription onChange error', {
          collectionName, subscriptionId,
          previousRecordCount: sentRecordIds.length,
          capturedS2CIsNoOp: capturedS2C.isNoOp,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    onUnsubscribe(() => removeOnChange(watchId));

    try {
      const [recordIds, total] = await refreshQueryAndPushToSubscriber();
      rememberSentResult(recordIds, total);
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
