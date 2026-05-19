import { createServerActionHandler } from '@anupheaus/nexus/server';
import { mxdbGetAction } from '../../common';
import { useDb, useServerToClientSynchronisation } from '../providers';

export async function handleGet(params: { collectionName: string; ids: string[]; }) {
  const { collectionName, ids } = params;
  const db = useDb();
  const s2c = useServerToClientSynchronisation();
  const dbCollection = db.use(collectionName);

  const records = await dbCollection.get(ids);
  if (records == null || records.length === 0) return [];

  await s2c.pushActive(collectionName, records);

  return records.ids();
}

export const serverGetAction = createServerActionHandler(mxdbGetAction, handleGet);
