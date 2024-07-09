import { Logger, Record, is } from '@anupheaus/common';
import { Get } from './createGet';
import { utils } from './utils';
import { useDb } from './DbContext';

export function createUpsert<RecordType extends Record>(name: string, get: Get<RecordType>, logger: Logger) {
  const { db, raiseCollectionEvent } = useDb();

  return async function upsert(record: RecordType) {
    logger.debug('Upserting record', record);
    const existingRecord = await get(record.id);
    if (is.deepEqual(existingRecord, record)) return;
    const col = db.transaction(name, 'readwrite').objectStore(name);
    await (async () => {
      if (existingRecord != null) {
        return utils.wrap(col.put(record));
      } else {
        return utils.wrap(col.add(record));
      }
    })();
    col.transaction.commit();
    raiseCollectionEvent(name, { type: 'upsert', record });
  };
}