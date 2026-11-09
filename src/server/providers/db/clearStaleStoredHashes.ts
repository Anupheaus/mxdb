import type { Logger, Record } from '@anupheaus/common';
import type { Collection } from 'mongodb';
import type { MongoDocOf } from '../../../common';
import { dbUtils } from './db-transforms';

interface ClearStaleStoredHashesRequest {
  collection: Collection<MongoDocOf<Record>>;
  /** The changed documents as stored, from the change stream. */
  documents: MongoDocOf<Record>[];
  logger: Logger;
}

/**
 * Removes each changed document's stored content hash (`_meta.hash`) when it no longer describes the content: a write
 * that bypassed mxdb left it behind. A client's sync compares the hash it holds with the stored one to skip reading the
 * record (the C2S meta fast-path), so a stale one would tell a client holding the old content that it is up to date, and
 * the change would never reach it (sc-3577). With the hash gone the record is read and compared in full.
 *
 * The removal is conditional on the stale hash still being stored, so a write mxdb makes meanwhile (with a correct
 * hash) is never undone. Removing a hash can only cost a fuller read; it can never make a stale copy look current.
 * A failure is logged and left: the next mxdb write of the record stores a correct hash again.
 */
export async function clearStaleStoredHashes({ collection, documents, logger }: ClearStaleStoredHashesRequest): Promise<void> {
  await documents.mapAsync(async storedDocument => {
    const recordId = String(storedDocument._id);
    try {
      const staleHash = await dbUtils.staleStoredHashOf(storedDocument);
      if (staleHash == null) return;
      await collection.updateOne({ _id: storedDocument._id, '_meta.hash': staleHash } as never, { $unset: { '_meta.hash': '' } } as never);
      logger.info('[ServerDb] cleared a stale stored hash (the record was written without mxdb)', { collectionName: collection.collectionName, recordId });
    } catch (error) {
      logger.warn('[ServerDb] could not clear a stale stored hash', { collectionName: collection.collectionName, recordId, error: String((error as Error)?.message ?? error) });
    }
  });
}
