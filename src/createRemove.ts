import { InternalError, Logger, Record, is } from '@anupheaus/common';
import { utils } from './utils';
import { useDb } from './DbContext';

export function createRemove<RecordType extends Record>(name: string, logger: Logger) {
  const { db, raiseCollectionEvent } = useDb();

  async function remove(id: string): Promise<void>;
  async function remove(ids: string[]): Promise<void>;
  async function remove(record: RecordType): Promise<void>;
  async function remove(records: RecordType[]): Promise<void>;
  async function remove(records: string | string[] | RecordType | RecordType[]) {
    if (!is.array(records)) {
      if (is.plainObject(records)) return remove([records]);
      return remove([records]);
    } else {
      let collection = db.transaction(name, 'readonly').objectStore(name);
      const [actualRecords, errors] = await Promise.whenAllSettled(records.map(async record => is.string(record) ? utils.wrap(collection.get(record)) : record));
      if (errors.length > 0) throw new InternalError('Some records could not be found to be removed', { meta: { errors } });
      logger.debug('Removing records...', actualRecords);
      const transaction = db.transaction(name, 'readwrite');
      collection = transaction.objectStore(name);
      await Promise.allSettled(actualRecords.map(async record => utils.wrap(collection.delete(record.id))));
      transaction.commit();
      logger.debug('Removing records completed.');
      raiseCollectionEvent(name, { type: 'remove', records: actualRecords });
    }
  }

  return remove;
}