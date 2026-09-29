import { createServerActionHandler } from '@anupheaus/nexus/server';
import type { Record } from '@anupheaus/common';
import { mxdbQueryAction } from '../../common';
import type { QueryProps } from '../../common';
import { useDb, useServerToClientSynchronisation } from '../providers';
import { useQueryGate } from '../collections/useQueryGate';

export async function handleQuery(params: { collectionName: string;[key: string]: unknown; }) {
  const { collectionName, ...request } = params;
  const db = useDb();
  const s2c = useServerToClientSynchronisation();
  const dbCollection = db.use(collectionName);
  const { gateRequest } = useQueryGate(dbCollection.collection);

  const queryRequest = await gateRequest(request as QueryProps<Record>);

  const { data: records, total } = await dbCollection.query(queryRequest as any);
  if (records.length === 0) return [];

  await s2c.pushActive(collectionName, records);

  return total;
}

export const serverQueryAction = createServerActionHandler(mxdbQueryAction, handleQuery);
