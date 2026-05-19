import { createServerActionHandler } from '@anupheaus/nexus/server';
import { mxdbGetAllAction } from '../../common';
import { useDb, useServerToClientSynchronisation } from '../providers';

export async function handleGetAll(params: { collectionName: string }) {
  const { collectionName } = params;
  const db = useDb();
  const s2c = useServerToClientSynchronisation();
  const dbCollection = db.use(collectionName);

  const records = await dbCollection.getAll();
  if (records.length === 0) return [];

  await s2c.pushActive(collectionName, records);

  return records.ids();
}

export const serverGetAllAction = createServerActionHandler(mxdbGetAllAction, handleGetAll);
