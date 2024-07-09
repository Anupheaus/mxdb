import { Logger, Record } from '@anupheaus/common';
import { utils } from './utils';
import { useDb } from './DbContext';

export function createUpsert<RecordType extends Record>(name: string, logger: Logger) {
  const { db, raiseCollectionEvent } = useDb();

  async function upsert(record: RecordType): Promise<void>;
  async function upsert(records: RecordType[]): Promise<void>;
  async function upsert(records: RecordType | RecordType[]): Promise<void> {
    if (!Array.isArray(records)) return upsert([records]);
    logger.debug('Upserting records', records);
    const transaction = db.transaction(name, 'readwrite');
    const collection = transaction.objectStore(name);
    await Promise.allSettled(records.map(record => utils.wrap(collection.put(record))));
    transaction.commit();
    logger.debug('Upsert completed.');
    raiseCollectionEvent(name, { type: 'upsert', records });
  }

  return upsert;
}