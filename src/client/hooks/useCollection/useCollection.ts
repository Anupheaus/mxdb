import type { Record, Unsubscribe } from '@anupheaus/common';
import type { MXDBCollection, MXDBCollectionChangeEvent } from '../../../common';
import { createGet } from './createGet';
import { createUseGet } from './createUseGet';
import { createUpsert } from './createUpsert';
import { createRemove } from './createRemove';
import { createQuery } from './createQuery';
import { createUseQuery } from './createUseQuery';
import { createTableRequest } from './createTableRequest';
import { createUseSubscription } from './createUseSubscription';
import { createDistinct } from './createDistinct';
import { createFind } from './createFind';
import { createUseDistinct } from './createUseDistinct';
import { useLogger } from '@anupheaus/react-ui';
import { useDb } from '../../providers';
import { createGetAll } from './createGetAll';
import { createUseGetAll } from './createUseGetAll';
import { configRegistry } from '../../../common/registries';
import type { DbCollection } from '../../providers/dbs/DbCollection';

function createOnChange<RecordType extends Record>(dbCollection: DbCollection<RecordType>) {
  return (callback: (event: MXDBCollectionChangeEvent<RecordType>) => void): Unsubscribe =>
    dbCollection.onChange(internalEvent => {
      if (internalEvent.type === 'upsert') {
        callback({ type: 'upsert', records: internalEvent.records });
      } else if (internalEvent.type === 'remove') {
        callback({ type: 'remove', recordIds: internalEvent.ids });
      } else if (internalEvent.type === 'clear' && internalEvent.ids.length > 0) {
        callback({ type: 'remove', recordIds: internalEvent.ids });
      }
    });
}

export function useCollection<RecordType extends Record>(collection: MXDBCollection<RecordType>, dbName?: string) {
  const { db } = useDb(dbName);
  const config = configRegistry.getOrError(collection);

  // Wrong-side collection guard: ServerOnly collections must not be used on the client
  if (config.syncMode === 'ServerOnly') {
    throw new Error(`Collection "${collection.name}" is ServerOnly and cannot be accessed on the client.`);
  }

  const dbCollection = db.use<RecordType>(collection.name);
  const logger = useLogger(collection.name);

  const get = createGet(dbCollection);
  const upsert = createUpsert(dbCollection, logger);
  const remove = createRemove(dbCollection, logger);
  const useSubscription = createUseSubscription();
  const getAll = createGetAll(dbCollection, useSubscription, logger);
  const query = createQuery(dbCollection, useSubscription, logger);
  const distinct = createDistinct(dbCollection, useSubscription, logger);
  const find = createFind(query);
  const tableRequest = createTableRequest(query);
  const useGet = createUseGet(dbCollection, get);
  const useQuery = createUseQuery(createQuery(dbCollection, useSubscription, logger), logger);
  const useDistinct = createUseDistinct(distinct);
  const useGetAll = createUseGetAll(getAll);
  const onChange = createOnChange(dbCollection);

  return {
    config,
    get,
    getAll,
    upsert,
    remove,
    query,
    find,
    distinct,
    useGet,
    useQuery,
    useDistinct,
    useGetAll,
    useSubscription,
    tableRequest,
    onChange,
  };
}
