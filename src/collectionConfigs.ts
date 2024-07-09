import { MXDBCollection, MXDBCollectionConfig } from './models';

export const collectionConfigs = new WeakMap<MXDBCollection<any>, MXDBCollectionConfig<any>>();
