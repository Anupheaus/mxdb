import type { Record } from '@anupheaus/common';
import type { MXDBCollection } from './models';
import { createGet } from './createGet';
import { createUpsert } from './createUpsert';
import { createUseGet } from './createUseGet';
import { createRemove } from './createRemove';
import { createQuery } from './createQuery';
import { createUseQuery } from './createUseQuery';
import { createClear } from './createClear';
import { useLogger } from './logger';
import { configRegistry } from './configRegistry';
import { createGetRecordCount } from './createGetRecordCount';

export function useCollection<RecordType extends Record>(collection: MXDBCollection<RecordType>, dbName?: string) {
  const logger = useLogger(collection.name);
  const config = configRegistry.getOrError(collection);
  const get = createGet<RecordType>(config, dbName);
  const upsert = createUpsert<RecordType>(config, dbName, logger);
  const useGet = createUseGet<RecordType>(collection.name, get, dbName);
  const remove = createRemove<RecordType>(collection.name, get, dbName, logger);
  const query = createQuery<RecordType>(collection, config, dbName, logger);
  const useQuery = createUseQuery<RecordType>(query);
  const clear = createClear(collection.name, dbName);
  const getCount = createGetRecordCount(collection.name, dbName);

  return {
    get,
    upsert,
    useGet,
    remove,
    query,
    useQuery,
    clear,
    getCount,
  };
}
