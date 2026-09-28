import { getCollectionExtensions, type SeedWithFn, type SeedWithProps } from '../collections/extendCollection';
import { useCollection } from '../collections';
import type { UseCollection } from '../collections/useCollection';
import { Error, InternalError, is, useLogger } from '@anupheaus/common';

import type { Logger, Record } from '@anupheaus/common';
import type { MXDBCollection } from '../../common';
import { useSeedState, type SeedState } from './seedState';

/** Common `UseCollection` type – function that returns collection API + seedWith for any collection. */
export type UseSeedCollection = <RecordType extends Record>(collection: MXDBCollection<RecordType>) => UseCollection<RecordType> & {
  seedWith: SeedWithFn<RecordType>;
};

interface SeedHash {
  /** The hash of the fixed records last applied to this collection in this database; undefined if never recorded. */
  stored: string | undefined;
  /** Records a hash once the records it describes have been written. */
  save(hash: string): Promise<void>;
}

function seedWith<RecordType extends Record>(
  { getAll, upsert }: ReturnType<typeof useCollection<RecordType>>,
  seedHash: SeedHash,
  logger: Logger,
): SeedWithFn<RecordType> {
  return async ({ count: providedCount, fixedRecords, create, validate }: SeedWithProps<RecordType>) => {
    const count = providedCount ?? fixedRecords?.length;
    if (count == null) throw new InternalError('Count or Fixed Records is required for seeding.');
    const newSeedHash = fixedRecords != null ? Object.hash(fixedRecords) : undefined;
    if (newSeedHash != null && newSeedHash === seedHash.stored) {
      logger.debug('Fixed records have not changed, skipping seeding.');
      return;
    }
    const storedRecords = await getAll();

    // No hash recorded for a collection that already holds records: a database seeded before its hashes were kept in
    // the database (they used to live in a working-directory file). Adopt it: add only the fixed records it lacks and
    // never overwrite a stored one, so records edited in the app survive the upgrade. An empty collection is seeded
    // in full below.
    if (newSeedHash != null && seedHash.stored == null && storedRecords.length > 0 && fixedRecords != null && fixedRecords.length > 0) {
      const missing = fixedRecords.filter(fixedRecord => storedRecords.findById(fixedRecord.id) == null);
      if (missing.length > 0) await upsert(missing, { resetAudit: true });
      await seedHash.save(newSeedHash);
      logger.debug('Adopted existing records; added only the missing fixed records.', { added: missing.length });
      return missing;
    }

    const recordIdsToUpsert = new Set<string>();

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

    if (records.length < count) {
      if (!is.function(create)) throw new InternalError('Create function is required for seeding when count is greater than the number of records in the database.');
      const recordsToCreate = Array.ofSize(count - records.length).map(() => create());
      records = records.concat(recordsToCreate);
      recordIdsToUpsert.addMany(recordsToCreate.ids());
    }

    if (is.function(validate)) {
      await records.forEachAsync(async record => {
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
    // Only once the records are written, so a failed seed is retried on the next start.
    if (newSeedHash != null) await seedHash.save(newSeedHash);

    return records;
  };
}

/**
 * Runs every collection's `onSeed` against the ambient database. Which fixed records each collection last applied is
 * kept in that database (`mxdb_seeds`, see `seedState.ts`), so seeding is per database and survives a server whose
 * working directory is replaced on every deploy.
 */
export async function seedCollections(collections: MXDBCollection[]) {
  const logger = useLogger();
  logger.info('Seeding collections...');
  let seedState: SeedState;
  try {
    seedState = await useSeedState();
  } catch (error) {
    logger.error('Could not read the seed state; skipping seeding.', { error: new Error({ error }) });
    return;
  }
  logger.debug('Seed state loaded.', { seededCollections: [...seedState.hashes.keys()] });

  for (const collection of collections) {
    const extensions = getCollectionExtensions(collection);
    if (extensions?.onSeed == null) continue;
    logger.silly(`Seeding "${collection.name}" collection...`);
    const startTime = Date.now();
    try {
      const seedHash: SeedHash = {
        stored: seedState.hashes.get(collection.name),
        save: hash => seedState.save(collection.name, hash),
      };
      const subLogger = logger.createSubLogger(collection.name);
      const api = useCollection(collection);
      const seedWithFn = seedWith(api, seedHash, subLogger);
      await extensions.onSeed(seedWithFn);
      logger.debug(`Collection "${collection.name}" seeded (time taken: ${Date.now() - startTime}ms).`);
    } catch (error) {
      logger.error(`Error seeding collection "${collection.name}":`, { error: new Error({ error }) });
    }
  }
  logger.info('Collections seeded.');
}
