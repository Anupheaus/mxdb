import { Record } from '@anupheaus/common';
import { Collection } from './models';
import { useLogger } from '@anupheaus/react-ui';
import { createGet } from './createGet';
import { createUpsert } from './createUpsert';
import { createUseGet } from './createUseGet';
import { createRemove } from './createRemove';
import { createQuery } from './createQuery';
import { createUseQuery } from './createUseQuery';

export function useCollection<RecordType extends Record>(collection: Collection<RecordType>) {
  const logger = useLogger(collection.name);

  const get = createGet<RecordType>(collection.name);
  const upsert = createUpsert(collection.name, get, logger);
  const useGet = createUseGet(collection.name, get);
  const remove = createRemove(collection.name, get, logger);
  const query = createQuery(collection);
  const useQuery = createUseQuery(collection.name, query);

  return {
    get,
    upsert,
    useGet,
    remove,
    query,
    useQuery,
  };
}
