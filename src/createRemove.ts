import { Logger, Record, is } from '@anupheaus/common';
import { utils } from './utils';
import { useDb } from './DbContext';
import { Get } from './createGet';

export function createRemove<RecordType extends Record>(name: string, get: Get<RecordType>, logger: Logger) {
  const { db, raiseCollectionEvent } = useDb();
  async function remove(id: string): Promise<void>;
  async function remove(record: RecordType): Promise<void>;
  async function remove(idOrRecord: string | RecordType) {
    if (is.plainObject(idOrRecord)) return remove(idOrRecord.id);
    const id = idOrRecord;
    const record = await get(id);
    if (record == null) return;
    logger.debug(`Removing record "${id}"...`);
    const col = db.transaction(name, 'readwrite').objectStore(name);
    await utils.wrap(col.delete(id));
    col.transaction.commit();
    raiseCollectionEvent(name, { type: 'remove', record });
  }
  return remove;
}