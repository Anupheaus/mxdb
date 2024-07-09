import { Record } from '@anupheaus/common';
import { Collection, CollectionConfig } from './models';
import { collectionConfigs } from './collectionConfigs';

export function defineCollection<RecordType extends Record>(config: CollectionConfig<RecordType>) {
  const collection = {
    name: config.name,
    type: null as unknown as RecordType,
    sortableFields: config.indexes.flatMap(index => index.fields),
  } as const satisfies Collection<RecordType>;
  collectionConfigs.set(collection, config);
  return collection;
}