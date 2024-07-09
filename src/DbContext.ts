import { Logger, Record, Unsubscribe } from '@anupheaus/common';
import { MXDBCollection } from './models';
import { utils } from './utils';
import { createContext, useContext } from 'react';
import { openDb } from './openDb';
import { addDbToSchemaDbs, getAllSchemaDbs, getSchemaDb } from './schemaDb';

async function getDb(name: string, collections: MXDBCollection[], logger: Logger) {
  logger.info(`Opening database "${name}"...`);
  const collectionsHash = utils.hashCollections(collections);
  const schemaDb = await getSchemaDb(logger);
  const dbRecords = await getAllSchemaDbs(schemaDb);
  const dbRecord = dbRecords.find(record => record.id === name);
  if (dbRecord != null) {
    if (dbRecord.collectionsHash !== collectionsHash) {
      logger.info(`Database "${name}" found, however, the collection state is different, deleting...`);
      await utils.wrap(window.indexedDB.deleteDatabase(name));
    } else {
      logger.info(`Database "${name}" found and collection state is the same.`);
    }
  } else {
    logger.info(`Database "${name}" not found.`);
  }
  await addDbToSchemaDbs(schemaDb, name, collectionsHash);
  const db = openDb(name, collections, logger);
  logger.info(`Database "${name}" opened and ready to use.`);
  return db;
}

export interface CollectionEvent<RecordType extends Record> {
  type: 'upsert' | 'remove';
  records: RecordType[];
}

export interface DbContextProps {
  db: IDBDatabase;
  collections: MXDBCollection[];
  onCollectionEvent<RecordType extends Record>(name: string, callback: (event: CollectionEvent<RecordType>) => void): Unsubscribe;
  raiseCollectionEvent<RecordType extends Record>(name: string, event: CollectionEvent<RecordType>): void;
}

export const DbContext = createContext<DbContextProps | null>(null);

export async function createDbContext(name: string, collections: MXDBCollection[], logger: Logger): Promise<DbContextProps> {
  const db = await getDb(name, collections, logger);

  const onCollectionEvent = <RecordType extends Record>(collectionName: string, callback: (event: CollectionEvent<RecordType>) => void) => {
    const events = new BroadcastChannel(`MXDB.${name}.${collectionName}`);
    events.addEventListener?.('message', event => callback(event.data));
    return () => events.close();
  };

  const raiseCollectionEvent = <RecordType extends Record>(collectionName: string, event: CollectionEvent<RecordType>) => {
    const events = new BroadcastChannel(`MXDB.${name}.${collectionName}`);
    if (events == null) return;
    events.postMessage(event);
    events.close();
  };

  return {
    db,
    collections,
    onCollectionEvent,
    raiseCollectionEvent,
  };
}

export function useDb() {
  const context = useContext(DbContext);
  if (context == null) throw new Error('No DbContext found');
  return context;
}