import { mxdbDistinctSubscription } from '../../common';
import { useCollection } from '../collections';
import { useServerToClientSynchronisation } from '../providers';
import { createServerCollectionSubscription } from './createServerCollectionSubscription';
import { pushSubscriptionResultRecords } from './pushSubscriptionResultRecords';

export const serverDistinctSubscription = createServerCollectionSubscription()(mxdbDistinctSubscription,
  async ({ request: { collectionName, ...request }, subscriptionId, update, onUnsubscribe }) => {
    const { collection, distinct, onChange, removeOnChange } = useCollection(collectionName);
    // Capture at subscription-setup time. onChange callbacks fire from the MongoDB change stream
    // outside any ALS context, so a late useServerToClientSynchronisation() would fall back to the no-op.
    const capturedS2C = useServerToClientSynchronisation();

    const runDistinct = () => distinct(request);

    async function refreshDistinctAndPushToSubscriber(): Promise<string[]> {
      const records = await runDistinct();
      await pushSubscriptionResultRecords(capturedS2C, collection, records, []);
      return records.ids();
    }

    // The hash the client currently holds: the initial response, then each update sent since. Changes are
    // compared against this — not the `previousResponse` remembered from an earlier subscribe, which this
    // subscribe's fresh initial response has already superseded on the client.
    let sentHash: string | undefined;

    const internalSubscriptionId = `mxdb.distinct.${subscriptionId}`;
    onChange(internalSubscriptionId, async () => {
      const newRecordIds = await refreshDistinctAndPushToSubscriber();
      const newHash = newRecordIds.join('|').hash();
      // a record is new, should now appear in this query, or has changed place
      if (newHash === sentHash) return;
      sentHash = newHash;
      await update(newHash);
    });

    onUnsubscribe(() => removeOnChange(internalSubscriptionId));

    const recordIds = await refreshDistinctAndPushToSubscriber();
    sentHash = recordIds.join('|').hash();
    return sentHash;
  });
