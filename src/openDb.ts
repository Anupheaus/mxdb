import { Logger } from '@anupheaus/common';
import { Collection, CollectionConfig, CollectionIndex } from './models';
import { collectionConfigs } from './collectionConfigs';
import { utils } from './utils';

function updateIndexes(store: IDBObjectStore, indexes: CollectionIndex[]) {
  store.createIndex('primary-key', ['id'], { unique: true });
  const existingIndexes = Array.from(store.indexNames);
  indexes.forEach(index => {
    const indexName = index.name ?? `${index.fields.join('|')}|${index.isUnique === true}`;
    store.createIndex(indexName, index.fields as string[], { unique: index.isUnique === true });
    existingIndexes.splice(existingIndexes.indexOf(indexName), 1);
  });
  if (existingIndexes.length > 0) existingIndexes.forEach(indexName => store.deleteIndex(indexName));
}

async function seedCollection(config: CollectionConfig) {
  if (config.onSeed == null) return;
  await config.onSeed?.();
}

export function openDb(name: string, collections: Collection[], logger: Logger) {
  const request = window.indexedDB.open(name, 1);
  request.onupgradeneeded = event => {
    logger.debug(`Upgrading database "${name}"...`);
    const db = (event.target as any).result as IDBDatabase;
    collections.forEach(collection => {
      const config = collectionConfigs.get(collection);
      if (config == null) return;
      const store = db.createObjectStore(config.name, { keyPath: 'id' });
      updateIndexes(store, config.indexes);
      seedCollection(config);
    });
  };
  return utils.wrap(request);
}