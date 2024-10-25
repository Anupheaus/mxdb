import type { Logger, Record } from '@anupheaus/common';
import { is } from '@anupheaus/common';
import { utils } from './utils';
import { useDb } from './DbContext';
import type { Get } from './createGet';

export function createRemove<RecordType extends Record>(name: string, get: Get<RecordType>, dbName: string | undefined, logger: Logger) {
  const { db, raiseCollectionEvent } = useDb(dbName);

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
      if (records.length === 0) return;
      const actualRecords = await get(records.map(record => is.string(record) ? record : record.id));
      logger.debug('Removing records...', { count: actualRecords.length });
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