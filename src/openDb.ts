import type { Logger } from '@anupheaus/common';
import type { MXDBCollection, MXDBCollectionIndex } from './models';
import { utils } from './utils';
import { configRegistry } from './configRegistry';

function updateIndexes(store: IDBObjectStore, indexes: MXDBCollectionIndex[]) {
  store.createIndex('primary-key', ['id'], { unique: true });
  const existingIndexes = Array.from(store.indexNames).filter(name => name !== 'primary-key');
  indexes.forEach(index => {
    const indexName = index.name ?? `${index.fields.join('|')}|${index.isUnique === true}`;
    store.createIndex(indexName, index.fields as string[], { unique: index.isUnique === true });
    existingIndexes.splice(existingIndexes.indexOf(indexName), 1);
  });
  if (existingIndexes.length > 0) existingIndexes.forEach(indexName => store.deleteIndex(indexName));
}

export async function openDb(name: string, collections: MXDBCollection[], logger: Logger) {
  const request = window.indexedDB.open(name, 1);
  request.onupgradeneeded = event => {
    logger.debug(`Upgrading database "${name}"...`);
    const db = (event.target as any).result as IDBDatabase;
    collections.forEach(collection => {
      const config = configRegistry.get(collection);
      if (config == null) {
        logger.warn(`Collection "${collection.name}" has no configuration.`);
        return;
      }
      const store = db.createObjectStore(config.name, { keyPath: 'id' });
      updateIndexes(store, config.indexes);
    });
  };
  return utils.wrap(request);
}