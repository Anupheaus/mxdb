import { collectionConfigs } from './collectionConfigs';
import { Collection } from './models';

function hashCollections(collections: Collection[]) {
  return collections
    .map(collection => {
      const config = collectionConfigs.get(collection);
      if (config == null) return '';
      const indexes = config.indexes.map(index => `${index.name}|${index.fields.join('|')}-${index.isUnique === true}`).join('#');
      return `${config.name}${indexes}`;
    })
    .join(',')
    .hash({ algorithm: 'md5' });
}

function wrap<T = unknown>(value: IDBRequest<T>): Promise<T>;
function wrap(value: IDBTransaction): Promise<void>;
function wrap(value: IDBRequest | IDBTransaction): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if ('oncomplete' in value) {
      value.oncomplete = () => resolve(void 0);
    } else {
      value.onsuccess = () => resolve(value.result);
    }
    value.onerror = () => reject(value.error);
  });
}

export const utils = {
  hashCollections,
  wrap,
};