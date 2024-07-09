import { Record } from '@anupheaus/common';
import { MXDBCollection, MXDBCollectionConfig } from './models';
import { collectionConfigs } from './collectionConfigs';

export function defineCollection<RecordType extends Record>(config: MXDBCollectionConfig<RecordType>) {
  const collection = {
    name: config.name,
    type: null as unknown as RecordType,
    sortableFields: config.indexes.flatMap(index => index.fields),
  } as const satisfies MXDBCollection<RecordType>;
  collectionConfigs.set(collection, config);
  return collection;
}