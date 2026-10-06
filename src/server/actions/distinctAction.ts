import { createClientActionHandler } from './createClientActionHandler';
import { mxdbDistinctAction } from '../../common';
import type { DistinctRequest } from '../../common';
import { useDb, useServerToClientSynchronisation } from '../providers';
import { useQueryGate } from '../collections/useQueryGate';

export async function handleDistinct({ collectionName, field, filters, sorts }: DistinctRequest) {
  const db = useDb();
  const s2c = useServerToClientSynchronisation();
  const dbCollection = db.use(collectionName);
  const { gateRequest } = useQueryGate(dbCollection.collection);

  // Distinct values are drawn only from the records the collection's gate lets this caller see.
  const { filters: gatedFilters, sorts: gatedSorts } = await gateRequest({ filters, sorts });
  const records = await dbCollection.distinct({ field, filters: gatedFilters, sorts: gatedSorts });
  if (records == null || records.length === 0) return [];

  await s2c.pushActive(collectionName, records);

  return records.ids().join('|').hash();
}


export const serverDistinctAction = createClientActionHandler(mxdbDistinctAction, handleDistinct);
