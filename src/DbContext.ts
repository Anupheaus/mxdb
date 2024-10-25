import type { Logger, Record, Unsubscribe } from '@anupheaus/common';
import { InternalError, is } from '@anupheaus/common';
import type { MXDBCollection } from './models';
import { utils } from './utils';
import { createContext, useContext } from 'react';
import { openDb } from './openDb';
import { addDbToSchemaDbs, getAllSchemaDbs, getSchemaDb } from './schemaDb';

async function getDb(name: string, collections: MXDBCollection[], logger: Logger) {
  logger.info(`Opening database "${name}"...`, { collections: collections.map(collection => collection.name) });
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
  const db = await openDb(name, collections, logger);
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

export interface DbsContextProps {
  dbs: Map<string, DbContextProps>;
  lastDb?: string;
}

export const DbsContext = createContext<DbsContextProps>({ dbs: new Map() });

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

export function useDb(name?: string) {
  const { dbs, lastDb } = useContext(DbsContext);
  if (is.empty(lastDb)) throw new InternalError('No MXDB context found');
  const context = dbs.get(name ?? lastDb);
  if (context == null) throw new InternalError(`No MXDB context found with the name "${name ?? lastDb}"`);
  return context;
}