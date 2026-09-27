import { is, type Record } from '@anupheaus/common';
import { mxdbGetAction } from '../../../common';
import type { DbCollection } from '../../providers';
import { useAction, useNexus } from '@anupheaus/nexus/client';

import { ACTION_TIMEOUT_MS, withTimeout } from '../../utils/actionTimeout';
import { fetchSharingInFlight } from './sharedServerGets';

export interface GetProps {
  locallyOnly?: boolean;
}

export function createGet<RecordType extends Record>(dbCollection: DbCollection<RecordType>) {
  const { getIsConnected } = useNexus();
  const { mxdbGetAction: getRecordFromServer } = useAction(mxdbGetAction);

  const fetchFromServer = (ids: string[]) => withTimeout(
    getRecordFromServer({ collectionName: dbCollection.name, ids }),
    ACTION_TIMEOUT_MS,
    `mxdbGetAction(${dbCollection.name})`,
  );

  async function get(id: string, props?: GetProps): Promise<RecordType | undefined>;
  async function get(ids: string[], props?: GetProps): Promise<RecordType[]>;
  async function get(ids: string | string[], props: GetProps = {}): Promise<RecordType | RecordType[] | undefined> {
    if (!is.array(ids)) return (await get([ids], props))[0];
    const { locallyOnly = false } = props;
    const records = await dbCollection.get(ids);
    const missingIds = ids.filter(id => records.findById(id) == null);
    // Only the server can supply what the local store lacks — and only when we may ask it and can reach it.
    if (locallyOnly || missingIds.length === 0 || !getIsConnected()) return records;
    // Concurrent gets of the same id share one server request (sc-40); only the missing ids are asked for.
    await fetchSharingInFlight({ dbCollection, ids: missingIds, fetch: fetchFromServer });
    return await dbCollection.get(ids);
  }

  return get;
}

export type Get<RecordType extends Record> = ReturnType<typeof createGet<RecordType>>;
