/**
 * WebAuthn-specific authentication collection.
 *
 * Extends the generic AuthCollection base with two extra sparse indexes
 * (registrationToken, keyHash) and the corresponding lookup methods required
 * by the WebAuthnAuthStore interface.
 */

import type { Collection } from 'mongodb';
import { Logger, is } from '@anupheaus/common';
import { toStoredKeyHash } from '@anupheaus/nexus/server';
import type { WebAuthnAuthRecord, WebAuthnAuthStore } from '@anupheaus/nexus/common';
import type { ServerDb } from '../providers';
import { AuthCollection, toAuthRecordUpdate } from './AuthCollection';
import { isAuthKey } from '@anupheaus/nexus/common';

type WebAuthnDoc = Omit<WebAuthnAuthRecord, 'requestId'> & { _id: string };

const KEY_HASH_INDEX = 'keyHash_1';
/** One key hash, one device (sc-613), over the records that have one: any number of pending invites have none. */
const UNIQUE_KEY_HASH_INDEX = { name: KEY_HASH_INDEX, unique: true, partialFilterExpression: { keyHash: { $type: 'string' } } };
/** The prefix nexus puts on the digest it stores (`toStoredKeyHash`); a key hash without it predates digests. */
const STORED_KEY_HASH_PREFIX = 'sha256:';

/** nexus's own words for a key hash another device holds: what a client may see and what its handlers log. */
const PASSKEY_ALREADY_REGISTERED = 'Passkey already registered';

/**
 * A write that broke the unique key hash index becomes nexus's plain "Passkey already registered". MongoDB's own error
 * names the index and repeats the stored digest, and would reach the client and the logs. Anything else passes through.
 */
function asPasskeyAlreadyRegistered(error: unknown): unknown {
  const { code, keyPattern, message } = (error ?? {}) as { code?: number; keyPattern?: Record<string, unknown>; message?: string; };
  const isKeyHashDuplicate = code === 11000 && (keyPattern != null ? 'keyHash' in keyPattern : String(message).includes(KEY_HASH_INDEX));
  return isKeyHashDuplicate ? new Error(PASSKEY_ALREADY_REGISTERED) : error;
}

/** Extra conditions a wrapper adds to `claimRegistration`. Not part of nexus's `WebAuthnAuthStore`. */
export interface ClaimRegistrationOptions {
  /** Claim only an invite created at or after this time (unix ms). `withInviteExpiry` sets it from the invite lifetime. */
  createdSince?: number;
}

export class WebAuthnAuthCollection
  extends AuthCollection<WebAuthnAuthRecord>
  implements WebAuthnAuthStore {

  constructor(db: ServerDb) {
    super(db);
  }

  protected override async createIndexes(coll: Collection<WebAuthnDoc>): Promise<void> {
    await super.createIndexes(coll as any);
    await coll.createIndex({ registrationToken: 1 }, { sparse: true });
    await coll.createIndex({ keyHash: 1 }, UNIQUE_KEY_HASH_INDEX);
  }

  /**
   * sc-613: nexus stores a digest of each device's key hash, and finds a device registered before that by its raw value.
   * On first opening an existing collection, every raw key hash becomes nexus's digest (`toStoredKeyHash`), and the key
   * hash index becomes unique. If two devices already share a key hash the index is left as it was and an error logged;
   * sign-in still works. Failures are logged, never thrown: sign-in works without either.
   */
  protected override async upgradeExisting(coll: Collection<WebAuthnDoc>): Promise<void> {
    const logger = !is.browser() ? Logger.getCurrent()?.createSubLogger('WebAuthnAuthCollection') : undefined;
    try {
      const raw = await coll.find({ keyHash: { $type: 'string', $not: new RegExp(`^${STORED_KEY_HASH_PREFIX}`) } } as any, { projection: { keyHash: 1 } }).toArray();
      if (raw.length > 0) {
        await coll.bulkWrite(raw.map(({ _id, keyHash }) => ({
          updateOne: { filter: { _id, keyHash } as any, update: { $set: { keyHash: toStoredKeyHash(keyHash as string) } } },
        })));
        logger?.info('Stored the key hashes of earlier devices as digests', { count: raw.length });
      }
      const existing = (await coll.indexes()).find(index => index.name === KEY_HASH_INDEX);
      if (existing?.unique === true) return;
      const [duplicate] = await coll.aggregate([
        { $match: { keyHash: { $type: 'string' } } },
        { $group: { _id: '$keyHash', count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 1 },
      ]).toArray();
      if (duplicate != null) {
        logger?.error('Two devices share a key hash, so the key hash index was left non-unique; remove one of them', { count: duplicate.count });
        return;
      }
      if (existing != null) await coll.dropIndex(KEY_HASH_INDEX);
      await coll.createIndex({ keyHash: 1 }, UNIQUE_KEY_HASH_INDEX);
    } catch (error) {
      logger?.error('Could not bring the key hashes in the auth collection up to date; sign-in is unaffected', { error });
    }
  }

  override async create(record: WebAuthnAuthRecord): Promise<void> {
    try { await super.create(record); } catch (error) { throw asPasskeyAlreadyRegistered(error); }
  }

  override async update(requestId: string, patch: Partial<WebAuthnAuthRecord>): Promise<void> {
    try { await super.update(requestId, patch); } catch (error) { throw asPasskeyAlreadyRegistered(error); }
  }

  // As in AuthCollection: a key that is not a non-empty string (an object is a MongoDB operator) finds and claims nothing.

  async findByRegistrationToken(registrationToken: string): Promise<WebAuthnAuthRecord | undefined> {
    if (!isAuthKey(registrationToken)) return undefined;
    const coll = await this.getColl() as unknown as Collection<WebAuthnDoc>;
    const doc = await coll.findOne({ registrationToken } as any);
    if (doc == null) return undefined;
    const { _id, ...rest } = doc;
    return { requestId: _id, ...rest };
  }

  /**
   * Registers a device on the invite holding `registrationToken` in ONE atomic write, so two registrations racing on the
   * same token cannot both succeed. The write applies `patch` and removes the token. It happens only while the record is
   * still a pending invite (the same test as nexus's `isPendingWebAuthnInvite`: not enabled, and no key hash, device
   * details or connection) and, given `createdSince`, still inside the invite lifetime. Resolves the record as it was
   * before the write, or `undefined` when nothing matched: the token was already used, the device has registered since,
   * or the invite has expired.
   */
  async claimRegistration(registrationToken: string, patch: Partial<WebAuthnAuthRecord>, { createdSince }: ClaimRegistrationOptions = {}): Promise<WebAuthnAuthRecord | undefined> {
    if (!isAuthKey(registrationToken)) return undefined;
    if (createdSince != null && (typeof createdSince !== 'number' || !Number.isFinite(createdSince))) return undefined;
    const coll = await this.getColl() as unknown as Collection<WebAuthnDoc>;
    // `field: null` matches a field that is missing or null, as `== null` does in isPendingWebAuthnInvite.
    const doc = await coll.findOneAndUpdate({
      registrationToken,
      isEnabled: { $ne: true },
      keyHash: null,
      deviceDetails: null,
      lastConnectedAt: null,
      ...(createdSince != null ? { createdAt: { $gte: createdSince } } : {}),
    } as any, toAuthRecordUpdate({ ...patch, registrationToken: undefined }), { returnDocument: 'before' })
      .catch(error => { throw asPasskeyAlreadyRegistered(error); });
    if (doc == null) return undefined;
    const { _id, ...rest } = doc;
    return { requestId: _id, ...rest };
  }

  async findByKeyHash(keyHash: string): Promise<WebAuthnAuthRecord | undefined> {
    if (!isAuthKey(keyHash)) return undefined;
    const coll = await this.getColl() as unknown as Collection<WebAuthnDoc>;
    const doc = await coll.findOne({ keyHash } as any);
    if (doc == null) return undefined;
    const { _id, ...rest } = doc;
    return { requestId: _id, ...rest };
  }

  /** Not part of WebAuthnAuthStore. Used by device management to list all records for a user. */
  async findByUserId(userId: string): Promise<WebAuthnAuthRecord[]> {
    return this.findAllByUserId(userId);
  }
}
