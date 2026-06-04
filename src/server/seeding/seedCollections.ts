import { getCollectionExtensions, type SeedWithFn, type SeedWithProps } from '../collections/extendCollection';
import { useCollection } from '../collections';
import type { UseCollection } from '../collections/useCollection';
import { Error, InternalError, is, useLogger } from '@anupheaus/common';

import type { Logger, Record } from '@anupheaus/common';
import type { MXDBCollection } from '../../common';
import { loadSeededData, saveSeededData } from './seededData';

/** Common `UseCollection` type – function that returns collection API + seedWith for any collection. */
export type UseSeedCollection = <RecordType extends Record>(collection: MXDBCollection<RecordType>) => UseCollection<RecordType> & {
  seedWith: SeedWithFn<RecordType>;
};

function seedWith<RecordType extends Record>(
  { getAll, upsert, remove }: ReturnType<typeof useCollection<RecordType>>,
  seedHash: string,
  updateSeedHash: (seedHash: string) => void,
  logger: Logger,
): SeedWithFn<RecordType> {
  return async ({ count: providedCount, fixedRecords, create, validate, preserveExtraRecords }: SeedWithProps<RecordType>) => {
    const count = providedCount ?? fixedRecords?.length;
    if (count == null) throw new InternalError('Count or Fixed Records is required for seeding.');
    if (fixedRecords != null) {
      const newSeedHash = Object.hash(fixedRecords);
      if (newSeedHash === seedHash) {
        logger.debug('Fixed records have not changed, skipping seeding.');
        return;
      }
      updateSeedHash(newSeedHash);
    }
    const storedRecords = await getAll();
    const recordIdsToUpsert = new Set<string>();
    const recordIdsToRemove = new Set<string>();

    let records = storedRecords.slice();
    if (fixedRecords != null && fixedRecords.length > 0) {
      recordIdsToUpsert.addMany(fixedRecords.mapWithoutNull(fixedRecord => {
        const existingStoredRecord = storedRecords.findById(fixedRecord.id);
        if (!existingStoredRecord) {
          records.push(fixedRecord);
          return fixedRecord.id;
        } else {
          if (is.deepEqual(existingStoredRecord, fixedRecord)) return;
          records = records.repsert(fixedRecord);
          return fixedRecord.id;
        }
      }));
    }

    if (!preserveExtraRecords && records.length > count) {
      const fixedIds = fixedRecords?.ids();
      const totalToRemoveCount = records.length - count;
      recordIdsToRemove.addMany((fixedIds == null ? records : records.filter(({ id }) => !fixedIds.includes(id))).slice(0, totalToRemoveCount).ids());
    }

    if (records.length < count) {
      if (!is.function(create)) throw new InternalError('Create function is required for seeding when count is greater than the number of records in the database.');
      const recordsToCreate = Array.ofSize(count - records.length).map(() => create());
      records = records.concat(recordsToCreate);
      recordIdsToUpsert.addMany(recordsToCreate.ids());
    }

    if (is.function(validate)) {
      await records.forEachAsync(async record => {
        if (recordIdsToRemove.has(record.id)) return;
        let validated = validate(record);
        if (validated === false) {
          if (!is.function(create)) throw new InternalError('Create function is required for seeding when validate returns false.');
          validated = { ...create(), id: record.id };
        }
        if (validated == null || validated === true) return;
        records = records.repsert(validated);
        recordIdsToUpsert.add(validated.id);
      });
    }

    records = records.filterByIds(recordIdsToUpsert.toArray());
    await upsert(records, { resetAudit: true });
    await remove(recordIdsToRemove.toArray(), { clearAudit: true });

    return records;
  };
}

export async function seedCollections(collections: MXDBCollection[]) {
  const logger = useLogger();
  logger.info('Seeding collections...');
  logger.debug('Loading seeded data...');
  const seededData = loadSeededData();
  logger.debug('Seeded data loaded.', { seededDataKeys: Object.keys(seededData) });

  for (const collection of collections) {
    const extensions = getCollectionExtensions(collection);
    if (extensions?.onSeed == null) continue;
    logger.silly(`Seeding "${collection.name}" collection...`);
    const startTime = Date.now();
    try {
      const seedHash = seededData[collection.name] ?? '';
      const updateSeedHash = (newHash: string) => { seededData[collection.name] = newHash; };
      const subLogger = logger.createSubLogger(collection.name);
      const api = useCollection(collection);
      const seedWithFn = seedWith(api, seedHash, updateSeedHash, subLogger);
      await extensions.onSeed(seedWithFn);
      logger.debug(`Collection "${collection.name}" seeded (time taken: ${Date.now() - startTime}ms).`);
    } catch (error) {
      logger.error(`Error seeding collection "${collection.name}":`, { error: new Error({ error }) });
    }
  }
  logger.debug('Saving seeded data...');
  saveSeededData(seededData);
  logger.debug('Seeded data saved.', { seededDataKeys: Object.keys(seededData) });
  logger.info('Collections seeded.');
}
