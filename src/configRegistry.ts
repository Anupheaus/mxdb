import type { Record } from '@anupheaus/common';
import type { MXDBCollection, MXDBCollectionConfig } from './models';

const registry = new WeakMap<MXDBCollection<Record>, MXDBCollectionConfig<any>>();

export const configRegistry = {
  add<RecordType extends Record>(collection: MXDBCollection<RecordType>, config: MXDBCollectionConfig<RecordType>): void {
    registry.set(collection, config);
  },
  get<RecordType extends Record>(collection: MXDBCollection<RecordType>): MXDBCollectionConfig<RecordType> | undefined {
    return registry.get(collection) as MXDBCollectionConfig<RecordType> | undefined;
  },
  getOrError<RecordType extends Record>(collection: MXDBCollection<RecordType>): MXDBCollectionConfig<RecordType> {
    const config = registry.get(collection) as MXDBCollectionConfig<RecordType> | undefined;
    if (!config) throw new Error(`The config for collection "${collection.name}" could not be retrieved.`);
    return config;
  },
};
