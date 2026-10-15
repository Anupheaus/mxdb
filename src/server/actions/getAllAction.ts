import type { Record } from '@anupheaus/common';
import { createClientActionHandler } from './createClientActionHandler';
import { mxdbGetAllAction } from '../../common';
import { useDb, useServerToClientSynchronisation } from '../providers';
import { useQueryGate } from '../collections/useQueryGate';

export async function handleGetAll(params: { collectionName: string }) {
  const { collectionName } = params;
  const db = useDb();
  const s2c = useServerToClientSynchronisation();
  const dbCollection = db.use(collectionName);
  const { getGateFilters } = useQueryGate(dbCollection.collection);

  // "All" means all the records the collection's gate lets this caller see.
  const gateFilters = await getGateFilters();
  const records: Record[] = gateFilters == null ? await dbCollection.getAll() : (await dbCollection.query({ filters: gateFilters })).data;
  if (records.length === 0) return [];

  await s2c.pushActive(collectionName, records);

  return records.ids();
}

export const serverGetAllAction = createClientActionHandler(mxdbGetAllAction, handleGetAll);
