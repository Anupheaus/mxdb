import { Logger, Record } from '@anupheaus/common';
import { openDb } from './openDb';
import { defineCollection } from './defineCollection';
import { utils } from './utils';

interface SchemaCollectionRecord extends Record {
  collectionsHash: string;
}

const dbsCollection = defineCollection<SchemaCollectionRecord>({
  name: 'dbs',
  indexes: [],
  version: 1
});

export function getSchemaDb(logger: Logger) {
  return openDb('mxdb', [dbsCollection], logger);
}

export async function getAllSchemaDbs(schemaDb: IDBDatabase) {
  const transaction = schemaDb.transaction('dbs', 'readonly');
  const dbs = transaction.objectStore('dbs');
  const allRecords = utils.wrap<SchemaCollectionRecord[]>(dbs.getAll());
  transaction.commit();
  return allRecords;
}

export async function addDbToSchemaDbs(schemaDb: IDBDatabase, name: string, collectionsHash: string) {
  const transaction = schemaDb.transaction('dbs', 'readwrite');
  const dbs = transaction.objectStore('dbs');
  dbs.delete(name);
  dbs.add({ id: name, collectionsHash });
  transaction.commit();
}
