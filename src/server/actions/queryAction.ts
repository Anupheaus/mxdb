import { createServerActionHandler, useAuthentication } from '@anupheaus/nexus/server';
import type { Record } from '@anupheaus/common';
import { mxdbQueryAction } from '../../common';
import type { QueryProps } from '../../common';
import { useDb, useServerToClientSynchronisation } from '../providers';
import { getCollectionExtensions } from '../collections/extendCollection';

export async function handleQuery(params: { collectionName: string;[key: string]: unknown; }) {
  const { collectionName, ...request } = params;
  const db = useDb();
  const s2c = useServerToClientSynchronisation();
  const dbCollection = db.use(collectionName);

  let queryRequest = request as QueryProps<Record>;
  const extensions = dbCollection.collection != null ? getCollectionExtensions(dbCollection.collection) : undefined;
  if (extensions?.onQuery != null) {
    const userId = (() => { try { return useAuthentication().user?.id; } catch { return undefined; } })();
    const modified = await extensions.onQuery({ request: queryRequest, userId });
    if (modified != null) queryRequest = modified;
  }

  const { data: records, total } = await dbCollection.query(queryRequest as any);
  if (records.length === 0) return [];

  await s2c.pushActive(collectionName, records);

  return total;
}

export const serverQueryAction = createServerActionHandler(mxdbQueryAction, handleQuery);
