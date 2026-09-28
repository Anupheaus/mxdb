import type { Db } from 'mongodb';
import { useDb } from '../providers/db';

/**
 * The MongoDB collection, in each seeded database, recording which fixed-record seed each collection last applied. One
 * document per seeded collection, keyed by the collection's name. Like `mxdb_authentication`, it is mxdb's own and is
 * not a synced collection.
 */
export const SEED_STATE_COLLECTION_NAME = 'mxdb_seeds';

interface SeedStateDoc {
  /** The seeded collection's name. */
  _id: string;
  /** `Object.hash` of the fixed records last applied to it. */
  hash: string;
  appliedAt: Date;
}

/** The seed hashes of one database: read once at the start of seeding, written per collection as each one succeeds. */
export interface SeedState {
  /** The hash each collection's fixed records had when last applied here; absent for a collection never recorded. */
  hashes: Map<string, string>;
  save(collectionName: string, hash: string): Promise<void>;
}

/** The seed state held in `db`. */
export async function loadSeedState(db: Db): Promise<SeedState> {
  const collection = db.collection<SeedStateDoc>(SEED_STATE_COLLECTION_NAME);
  const docs = await collection.find({}).toArray();
  const hashes = new Map(docs.map(doc => [doc._id, doc.hash]));
  return {
    hashes,
    async save(collectionName, hash) {
      await collection.replaceOne({ _id: collectionName }, { hash, appliedAt: new Date() }, { upsert: true });
      hashes.set(collectionName, hash);
    },
  };
}

/** The seed state of the ambient database: the one `useDb()` resolves, which is the one being seeded. */
export async function useSeedState(): Promise<SeedState> {
  return loadSeedState(await useDb().getMongoDb());
}
