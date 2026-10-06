import type { Record } from '@anupheaus/common';
import { useLogger } from '@anupheaus/nexus/server';
import type { MXDBReadableRecords, MXDBRecordStatesRequest } from '../../common/sync-engine';
import { useQueryGate } from '../collections/useQueryGate';
import { useDb } from '../providers';

/**
 * Of the given record ids, the live records the calling client may read, read through each collection's `onQuery`
 * gate in ONE query (`id in ids AND gate`), so the gate decision and the content are the same snapshot (sc-682). A
 * collection with no gate is read plainly and answers `isGated: false` (every id readable). With a gate, an id that does
 * not come back is deleted or outside it. A collection this database does not register gets NO answer, and is logged:
 * its gate cannot be judged, so it fails closed (sc-999) — the change stream pushes nothing for it, and the C2S receiver
 * treats every id in it as unreadable. Call it in the request's (or connection's) context: the gate is bound to the
 * signed-in caller.
 */
export async function readReadableRecords(request: MXDBRecordStatesRequest): Promise<MXDBReadableRecords> {
  const db = useDb();
  const answers = await request.mapAsync(async ({ collectionName, recordIds }) => {
    let dbCollection: ReturnType<typeof db.use> | undefined;
    try { dbCollection = db.use(collectionName); }
    catch { dbCollection = undefined; } // `use` throws or returns undefined for an unknown collection
    if (dbCollection == null) {
      useLogger().warn('Read gate: unknown collection — no record in it is readable', { collectionName, recordCount: recordIds.length });
      return undefined;
    }

    const gateFilters = await useQueryGate<Record>(dbCollection.collection).getGateFilters();
    if (gateFilters == null) return { collectionName, records: await dbCollection.get(recordIds), isGated: false };
    const { data } = await dbCollection.query({ filters: { $and: [{ id: { $in: recordIds } }, gateFilters] } });
    return { collectionName, records: data, isGated: true };
  });
  return answers.removeNull();
}
