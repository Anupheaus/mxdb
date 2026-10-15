import type { Record } from '@anupheaus/common';
import { createClientActionHandler } from './createClientActionHandler';
import { mxdbGetAction } from '../../common';
import { useDb, useServerToClientSynchronisation } from '../providers';
import { useQueryGate } from '../collections/useQueryGate';

export async function handleGet(params: { collectionName: string; ids: string[]; }) {
  const { collectionName, ids } = params;
  const db = useDb();
  const s2c = useServerToClientSynchronisation();
  const dbCollection = db.use(collectionName);
  const { getGateFilters } = useQueryGate(dbCollection.collection);

  // A gated collection answers only for the requested records the gate lets this caller see.
  const gateFilters = await getGateFilters();
  const records: Record[] = gateFilters == null
    ? await dbCollection.get(ids)
    : (await dbCollection.query({ filters: { $and: [{ id: { $in: ids } }, gateFilters] } })).data;
  if (records == null || records.length === 0) return [];

  await s2c.pushActive(collectionName, records);

  return records.ids();
}

export const serverGetAction = createClientActionHandler(mxdbGetAction, handleGet);
