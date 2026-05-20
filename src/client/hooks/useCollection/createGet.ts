import { is, type Record } from '@anupheaus/common';
import { mxdbGetAction } from '../../../common';
import type { DbCollection } from '../../providers';
import { useAction, useNexus } from '@anupheaus/nexus/client';

import { ACTION_TIMEOUT_MS, withTimeout } from '../../utils/actionTimeout';

interface GetProps {
  locallyOnly?: boolean;
}

export function createGet<RecordType extends Record>(dbCollection: DbCollection<RecordType>) {
  const { getIsConnected } = useNexus();
  const { mxdbGetAction: getRecordFromServer } = useAction(mxdbGetAction);

  async function get(id: string, props?: GetProps): Promise<RecordType | undefined>;
  async function get(ids: string[], props?: GetProps): Promise<RecordType[]>;
  async function get(ids: string | string[], props: GetProps = {}): Promise<RecordType | RecordType[] | undefined> {
    if (!is.array(ids)) return (await get([ids], props))[0];
    const { locallyOnly = false } = props;
    const records = await dbCollection.get(ids);
    // only fetch if we aren't solely looking locally and we don't have all the records locally and we are online
    if (!locallyOnly && ids.length > records.length && getIsConnected()) {
      const idsRetrieved = await withTimeout(
        getRecordFromServer({ collectionName: dbCollection.name, ids }),
        ACTION_TIMEOUT_MS,
        `mxdbGetAction(${dbCollection.name})`,
      );
      return await dbCollection.get(idsRetrieved);
    }
    return records;
  }

  return get;
}

export type Get<RecordType extends Record> = ReturnType<typeof createGet<RecordType>>;
