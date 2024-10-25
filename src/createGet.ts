import type { Record } from '@anupheaus/common';
import { is } from '@anupheaus/common';
import { utils } from './utils';
import { useDb } from './DbContext';
import type { MXDBCollectionConfig } from './models';
import { deserialise } from './transforms';
import { useLogger } from './logger';

export function createGet<RecordType extends Record>(config: MXDBCollectionConfig<RecordType>, dbName?: string) {
  const { db } = useDb(dbName);
  const logger = useLogger();

  async function get(id: string): Promise<RecordType | undefined>;
  async function get(ids: string[]): Promise<RecordType[]>;
  async function get(ids: string | string[]): Promise<RecordType | RecordType[] | undefined> {
    try {
      const col = db.transaction(config.name, 'readonly').objectStore(config.name);

      let isSingleId = false;
      if (!is.array(ids)) { ids = [ids]; isSingleId = true; }
      const [allRecords] = (await Promise.whenAllSettled<RecordType | undefined>(ids.map(id => utils.wrap(col.get(id)))));
      const onRead = config.onRead ?? (records => records);
      const records = await onRead(allRecords.removeNull().map(deserialise));
      return isSingleId ? records[0] : records;
    } catch (error) {
      if (error instanceof Error) logger.error('An error occurred trying to get a record from IndexedDB', { ids, error });
    }
  }

  return get;
}

export type Get<RecordType extends Record = Record> = ReturnType<typeof createGet<RecordType>>;