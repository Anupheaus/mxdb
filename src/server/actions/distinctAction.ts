import { createServerActionHandler } from '@anupheaus/nexus/server';
import { mxdbDistinctAction } from '../../common';
import type { DistinctRequest } from '../../common';
import { useDb, useServerToClientSynchronisation } from '../providers';

export async function handleDistinct({ collectionName, field, filters, sorts }: DistinctRequest) {
  const db = useDb();
  const s2c = useServerToClientSynchronisation();
  const dbCollection = db.use(collectionName);

  const records = await dbCollection.distinct({ field, filters, sorts });
  if (records == null || records.length === 0) return [];

  await s2c.pushActive(collectionName, records);

  return records.ids().join('|').hash();
}


export const serverDistinctAction = createServerActionHandler(mxdbDistinctAction, handleDistinct);
