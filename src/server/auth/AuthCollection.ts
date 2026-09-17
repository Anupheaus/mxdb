/**
 * Thin MongoDB wrapper for the `mxdb_authentication` collection.
 *
 * Intentionally NOT a ServerDbCollection — auth records should never be synced
 * to clients, and we don't need change streams or Atlas Admin-level index setup.
 *
 * Abstract generic base: subclasses bind a concrete TRecord type and may override
 * createIndexes() to add extra indices (call super.createIndexes() first).
 */

import type { Collection } from 'mongodb';
import type { NexusAuthRecord, NexusAuthStore } from '@anupheaus/nexus/common';
import type { ServerDb } from '../providers';
import { useDb } from '../providers';

const COLLECTION_NAME = 'mxdb_authentication';

type AuthDoc<TRecord extends NexusAuthRecord> = Omit<TRecord, 'requestId'> & { _id: string };

function toDoc<TRecord extends NexusAuthRecord>(record: TRecord): AuthDoc<TRecord> {
  const { requestId, ...rest } = record;
  return { _id: requestId, ...rest } as AuthDoc<TRecord>;
}

function fromDoc<TRecord extends NexusAuthRecord>(doc: AuthDoc<TRecord>): TRecord {
  const { _id, ...rest } = doc;
  return { requestId: _id, ...rest } as unknown as TRecord;
}

export abstract class AuthCollection<TRecord extends NexusAuthRecord> implements NexusAuthStore<TRecord> {

  /**
   * `db` is kept only as a fallback for callers that construct an `AuthCollection` outside any
   * `provideDb`/`useDb` scope (e.g. ad-hoc tooling). Queries never target it directly — see
   * `#getServerDb()`.
   */
  constructor(db: ServerDb) {
    this.#fallbackDb = db;
  }

  #fallbackDb: ServerDb;
  /** One initialized (collection-ensured + indexed) Mongo collection per distinct `ServerDb` seen,
   *  so per-connection routing (Phase 2a) can redirect the SAME `AuthCollection` instance at
   *  different tenant databases without re-running collection setup on every query. */
  #collByServerDb = new WeakMap<ServerDb, Promise<Collection<AuthDoc<TRecord>>>>();

  /**
   * Resolves the `ServerDb` this operation should query: the per-connection DB set by the
   * router (Phase 2a's `setDb`) when called inside a connection scope, otherwise the global
   * default `ServerDb` set by `provideDb` at startup — resolved fresh via `useDb()` on every
   * call so a single long-lived `AuthCollection` instance always targets the CURRENT db.
   * Falls back to the constructor-captured db if `useDb()` throws (no scope established at
   * all — see constructor doc).
   */
  #getServerDb(): ServerDb {
    try {
      return useDb();
    } catch {
      return this.#fallbackDb;
    }
  }

  /** Returns the underlying MongoDB collection for the CURRENT `ServerDb` (see `#getServerDb`).
   *  Subclasses use this for extra queries. */
  protected async getColl(): Promise<Collection<AuthDoc<TRecord>>> {
    const serverDb = this.#getServerDb();
    let coll = this.#collByServerDb.get(serverDb);
    if (coll == null) {
      coll = this.#init(serverDb);
      this.#collByServerDb.set(serverDb, coll);
    }
    return coll;
  }

  async #init(serverDb: ServerDb): Promise<Collection<AuthDoc<TRecord>>> {
    const db = await serverDb.getMongoDb();
    const names = await db.listCollections({ name: COLLECTION_NAME }).toArray();
    if (names.length === 0) {
      const coll = await db.createCollection<AuthDoc<TRecord>>(COLLECTION_NAME);
      await this.createIndexes(coll);
      return coll;
    }
    return db.collection<AuthDoc<TRecord>>(COLLECTION_NAME);
  }

  // Non-abstract so subclasses can call super.createIndexes() before adding their own.
  protected async createIndexes(coll: Collection<AuthDoc<TRecord>>): Promise<void> {
    await coll.createIndex({ userId: 1 });
    await coll.createIndex({ sessionToken: 1 }, { sparse: true });
    await coll.createIndex({ deviceId: 1 }, { sparse: true });
  }

  async create(record: TRecord): Promise<void> {
    const coll = await this.getColl();
    await coll.insertOne(toDoc(record) as any);
  }

  async findById(requestId: string): Promise<TRecord | undefined> {
    const coll = await this.getColl();
    const doc = await coll.findOne({ _id: requestId } as any);
    return doc ? fromDoc(doc as AuthDoc<TRecord>) : undefined;
  }

  async findBySessionToken(token: string): Promise<TRecord | undefined> {
    const coll = await this.getColl();
    const doc = await coll.findOne({ sessionToken: token } as any);
    return doc ? fromDoc(doc as AuthDoc<TRecord>) : undefined;
  }

  async findByDevice(userId: string, deviceId: string): Promise<TRecord | undefined> {
    const coll = await this.getColl();
    const doc = await coll.findOne({ userId, deviceId } as any);
    return doc ? fromDoc(doc as AuthDoc<TRecord>) : undefined;
  }

  /** Not part of NexusAuthStore. Used by device management to list all records for a user regardless of auth mode. */
  async findAllByUserId(userId: string): Promise<TRecord[]> {
    const coll = await this.getColl();
    const docs = await coll.find({ userId } as any).toArray();
    return docs.map(doc => fromDoc(doc as AuthDoc<TRecord>));
  }

  /** Pending invites that were created before `createdBeforeMs` (unix ms). */
  async findStalePendingInvites(createdBeforeMs: number): Promise<TRecord[]> {
    const coll = await this.getColl();
    const docs = await coll.find({
      isEnabled: false,
      deviceDetails: { $exists: false },
      lastConnectedAt: { $exists: false },
      createdAt: { $lt: createdBeforeMs },
    } as any).toArray();
    return docs.map(doc => fromDoc(doc as AuthDoc<TRecord>));
  }

  async update(requestId: string, patch: Partial<TRecord>): Promise<void> {
    const coll = await this.getColl();
    const setFields: Record<string, unknown> = {};
    const unsetFields: Record<string, 1> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) unsetFields[key] = 1;
      else setFields[key] = value;
    }
    const update: Record<string, unknown> = {};
    if (Object.keys(setFields).length > 0) update['$set'] = setFields;
    if (Object.keys(unsetFields).length > 0) update['$unset'] = unsetFields;
    if (Object.keys(update).length > 0) {
      await coll.updateOne({ _id: requestId } as any, update);
    }
  }

  async delete(requestId: string): Promise<void> {
    const coll = await this.getColl();
    await coll.deleteOne({ _id: requestId } as any);
  }
}
