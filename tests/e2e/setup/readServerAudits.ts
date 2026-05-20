import { MongoClient } from 'mongodb';
import type { ServerAuditOf } from '../../../src/common';
import { dbUtils } from '../../../src/server/providers/db/db-transforms';
import { E2E_MONGO_DB_NAME } from './mongoConstants';
import type { E2eTestRecord } from './e2eTestFixture';

export interface ReadServerAuditDocumentsOptions {
  dbName?: string;
}

/**
 * Load all persisted audit documents from Mongo `{liveCollectionName}_sync`
 * (same companion as {@link ServerDbCollection}’s `#getAuditCollection`).
 */
export async function readServerAuditDocuments(
  mongoUri: string,
  liveCollectionName: string,
  options?: ReadServerAuditDocumentsOptions,
): Promise<Map<string, ServerAuditOf<E2eTestRecord>>> {
  const dbName = options?.dbName ?? E2E_MONGO_DB_NAME;
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const coll = db.collection(`${liveCollectionName}_sync`);
    const docs = await coll.find({}).toArray();
    const map = new Map<string, ServerAuditOf<E2eTestRecord>>();
    for (const doc of docs) {
      const des = dbUtils.deserialize(doc as never) as ServerAuditOf<E2eTestRecord> | undefined;
      if (des?.id != null) map.set(des.id, des);
    }
    return map;
  } finally {
    await client.close();
  }
}
