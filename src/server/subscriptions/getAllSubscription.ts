import type { Record } from '@anupheaus/common';
import { mxdbGetAllSubscription } from '../../common';
import { useCollection } from '../collections';
import { useQueryGate } from '../collections/useQueryGate';
import { useClient } from '../hooks';
import { useServerToClientSynchronisation } from '../providers';
import { createServerCollectionSubscription } from './createServerCollectionSubscription';
import { pushSubscriptionResultRecords } from './pushSubscriptionResultRecords';

export const serverGetAllSubscription = createServerCollectionSubscription<string[]>()(mxdbGetAllSubscription,
  async ({ request, subscriptionId, updateAdditionalData, update, onUnsubscribe }) => {
    const { collectionName } = request;
    const { collection, get, getAll, query, onChange, removeOnChange } = useCollection(collectionName);
    const { getData } = useClient();
    const capturedS2C = useServerToClientSynchronisation();
    // Resolved once, now: the change handler runs from the change stream, outside this request, where the
    // caller the gate scopes to can no longer be read.
    const gateFilters = await useQueryGate(collection).getGateFilters();

    /** Every record the gate lets this subscriber see. */
    async function getVisibleRecords(): Promise<Record[]> {
      if (gateFilters == null) return getAll();
      return (await query({ filters: gateFilters })).data;
    }

    /**
     * Of the ids that dropped out of the snapshot, those that were actually deleted. A record that merely left
     * the gate still exists: pushing it as a delete would tombstone it on the device, and a tombstone refuses
     * the record for good (delete-is-final) — even once the gate lets it back in.
     */
    async function getDeletedIds(droppedIds: string[]): Promise<string[]> {
      if (gateFilters == null || droppedIds.length === 0) return droppedIds;
      const storedIds = (await get(droppedIds)).ids();
      return droppedIds.filter(id => !storedIds.includes(id));
    }

    async function pushCurrentSnapshot(): Promise<string[]> {
      const priorIds = getData<string[]>(`subscription-data.additional.${subscriptionId}`) ?? [];
      const records = await getVisibleRecords();
      const newRecordIds = records.ids();
      const removedIds = await getDeletedIds(priorIds.filter(id => !newRecordIds.includes(id)));
      await pushSubscriptionResultRecords(capturedS2C, collection, records, removedIds);
      updateAdditionalData(newRecordIds);
      return newRecordIds;
    }

    const watchId = `mxdb.getAll.${subscriptionId}`;
    onChange(watchId, async () => {
      const priorIds = getData<string[]>(`subscription-data.additional.${subscriptionId}`) ?? [];
      const newRecordIds = await pushCurrentSnapshot();
      if (newRecordIds.length !== priorIds.length || priorIds.some((id, index) => newRecordIds[index] !== id)) {
        return update(newRecordIds);
      }
    });

    onUnsubscribe(() => removeOnChange(watchId));

    return pushCurrentSnapshot();
  });
