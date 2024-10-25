import type { Record } from '@anupheaus/common';
import type { MXDBCollection, MXDBCollectionConfig } from './models';
import { configRegistry } from './configRegistry';

export function defineCollection<RecordType extends Record>(config: MXDBCollectionConfig<RecordType>): MXDBCollection<RecordType> {
  const collection: MXDBCollection<RecordType> = {
    name: config.name,
    type: null as unknown as RecordType,
  };
  configRegistry.add(collection, config);
  return collection;
}
