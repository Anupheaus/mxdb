import type { Logger, Record } from '@anupheaus/common';
import type { MongoDocOf } from '../../../common';
import type { ServerDbCollection } from './ServerDbCollection';
import { dbUtils } from './db-transforms';

interface RecordDirectWritesRequest {
  collection: ServerDbCollection;
  /** The changed documents as stored, from the change stream. */
  documents: MongoDocOf<Record>[];
  logger: Logger;
}

/**
 * Of the documents a change-stream batch carried, has those written without mxdb (a fix by hand, a migration) recorded in
 * their records' histories as they happen (sc-5449), so the history shows when the change was made and the next edit keeps
 * it. Documents mxdb wrote carry a hash that describes them and are skipped without reading anything.
 *
 * A failure is logged and left: the next edit made in the app or on a device records the change itself.
 */
export async function recordDirectWrites({ collection, documents, logger }: RecordDirectWritesRequest): Promise<void> {
  try {
    const directlyWrittenIds = await documents.mapAsync(async storedDocument => (await dbUtils.isWrittenWithoutMxdb(storedDocument) ? String(storedDocument._id) : undefined));
    await collection.recordDirectWrites(directlyWrittenIds.removeNull());
  } catch (error) {
    logger.warn('[ServerDb] could not record a change written without mxdb', { collectionName: collection.name, error: String((error as Error)?.message ?? error) });
  }
}
