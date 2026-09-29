import type { Record } from '@anupheaus/common';
import type { MXDBRecordStatesRequest } from '../../common/sync-engine';
import { useQueryGate } from '../collections/useQueryGate';
import { useDb } from '../providers';

/**
 * Of the given record ids, those the calling client may read: each collection's `onQuery` gate, AND-ed with
 * the ids. Every id passes for a collection with no gate, and for a collection this database does not
 * register — it stores nothing, so there is nothing to withhold. Call it in the request's context: the gate
 * is bound to the signed-in caller.
 */
export async function filterReadableRecordIds(request: MXDBRecordStatesRequest): Promise<MXDBRecordStatesRequest> {
  const db = useDb();
  return request.mapAsync(async ({ collectionName, recordIds }) => {
    let dbCollection: ReturnType<typeof db.use> | undefined;
    try { dbCollection = db.use(collectionName); }
    catch { dbCollection = undefined; } // an unknown collection: nothing stored, nothing to withhold
    if (dbCollection == null) return { collectionName, recordIds };

    const gateFilters = await useQueryGate<Record>(dbCollection.collection).getGateFilters();
    if (gateFilters == null) return { collectionName, recordIds };
    const { data: readable } = await dbCollection.query({ filters: { $and: [{ id: { $in: recordIds } }, gateFilters] } });
    return { collectionName, recordIds: readable.ids() };
  });
}
