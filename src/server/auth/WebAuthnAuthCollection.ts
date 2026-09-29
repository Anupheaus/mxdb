/**
 * WebAuthn-specific authentication collection.
 *
 * Extends the generic AuthCollection base with two extra sparse indexes
 * (registrationToken, keyHash) and the corresponding lookup methods required
 * by the WebAuthnAuthStore interface.
 */

import type { Collection } from 'mongodb';
import type { WebAuthnAuthRecord, WebAuthnAuthStore } from '@anupheaus/nexus/common';
import type { ServerDb } from '../providers';
import { AuthCollection, toAuthRecordUpdate } from './AuthCollection';

type WebAuthnDoc = Omit<WebAuthnAuthRecord, 'requestId'> & { _id: string };

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
    await coll.createIndex({ keyHash: 1 }, { sparse: true });
  }

  async findByRegistrationToken(registrationToken: string): Promise<WebAuthnAuthRecord | undefined> {
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
    const coll = await this.getColl() as unknown as Collection<WebAuthnDoc>;
    // `field: null` matches a field that is missing or null, as `== null` does in isPendingWebAuthnInvite.
    const doc = await coll.findOneAndUpdate({
      registrationToken,
      isEnabled: { $ne: true },
      keyHash: null,
      deviceDetails: null,
      lastConnectedAt: null,
      ...(createdSince != null ? { createdAt: { $gte: createdSince } } : {}),
    } as any, toAuthRecordUpdate({ ...patch, registrationToken: undefined }), { returnDocument: 'before' });
    if (doc == null) return undefined;
    const { _id, ...rest } = doc;
    return { requestId: _id, ...rest };
  }

  async findByKeyHash(keyHash: string): Promise<WebAuthnAuthRecord | undefined> {
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
