import type { Logger, Record } from '@anupheaus/common';
import { utils } from './utils';
import { useDb } from './DbContext';
import type { MXDBCollectionConfig } from './models';
import { serialise } from './transforms';

export function createUpsert<RecordType extends Record>(config: MXDBCollectionConfig<RecordType>, dbName: string | undefined, logger: Logger) {
  const { db, raiseCollectionEvent } = useDb(dbName);

  async function upsert(record: RecordType): Promise<void>;
  async function upsert(records: RecordType[]): Promise<void>;
  async function upsert(records: RecordType | RecordType[]): Promise<void> {
    if (!Array.isArray(records)) return upsert([records]);
    if (records.length === 0) return;
    logger.debug('Upserting records', records);
    const transaction = db.transaction(config.name, 'readwrite');
    const store = transaction.objectStore(config.name);
    const onWrite = config.onWrite ?? (recs => recs);
    records = await onWrite(records);
    await Promise.allSettled(records.map(async record => utils.wrap(store.put(serialise(record)))));
    transaction.commit();
    logger.debug('Upsert completed.');
    raiseCollectionEvent(config.name, { type: 'upsert', records });
  }

  return upsert;
}