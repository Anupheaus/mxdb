import { useDb } from './DbContext';
import { utils } from './utils';

export function createClear(name: string, dbName?: string) {
  const { db, raiseCollectionEvent } = useDb(dbName);

  async function clear(): Promise<void> {
    const transaction = db.transaction(name, 'readwrite');
    const col = transaction.objectStore(name);
    const records = await utils.wrap(col.getAll());
    await utils.wrap(col.clear());
    transaction.commit();
    raiseCollectionEvent(name, { type: 'remove', records });
  }

  return clear;
}