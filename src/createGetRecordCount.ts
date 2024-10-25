import { useDb } from './DbContext';
import { utils } from './utils';

export function createGetRecordCount(name: string, dbName?: string) {
  const { db } = useDb(dbName);

  async function getRecordCount(): Promise<number> {
    const transaction = db.transaction(name, 'readonly');
    const col = transaction.objectStore(name);
    const count = await utils.wrap(col.count());
    transaction.commit();
    return count;
  }

  return getRecordCount;
}