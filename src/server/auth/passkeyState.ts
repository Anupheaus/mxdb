/**
 * Passkey-level state (sc-645), kept beside `mxdb_authentication` in the same database.
 *
 * A passkey synced by Google Password Manager or iCloud Keychain signs in on several installations, each its own device
 * record, but one key answers for all of them. What guards the passkey therefore lives on one document per passkey
 * (`_id` = credential id), not on any device: the sign-ins it has claimed, and whether it has been revoked. A device can be
 * deleted; this document is not, so a revoke outlives the device that caused it.
 */

import type { Db } from 'mongodb';
import { isAuthKey, type PasskeySignInClaim } from '@anupheaus/nexus/common';

export const PASSKEYS_COLLECTION = 'mxdb_passkeys';

/**
 * How many claimed sign-ins a passkey keeps (newest by issue time). A challenge lives two minutes and every sign-in takes
 * a person's gesture on an authenticator, so a passkey never answers this many in one challenge lifetime; an older claim
 * has expired, and the challenge signer refuses it anyway.
 */
const MAX_CLAIMED_SIGN_INS = 100;

/** MongoDB's duplicate key error: an upsert lost the race to insert the passkey's document. */
const DUPLICATE_KEY = 11_000;

interface ClaimedSignIn {
  challenge: string;
  issuedAt: number;
}

interface PasskeyDoc {
  _id: string;
  signIns?: ClaimedSignIn[];
  /** When a device of this passkey was first disabled or deleted (unix ms). Never cleared. */
  revokedAt?: number;
}

const passkeys = (db: Db) => db.collection<PasskeyDoc>(PASSKEYS_COLLECTION);

const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === DUPLICATE_KEY;

/**
 * Claims a verified sign-in for its passkey in ONE atomic write (nexus `WebAuthnAuthStore.claimPasskeySignIn`): only while
 * no device of the passkey has claimed this challenge, and, for a new device, only while the passkey is not revoked.
 * Resolves whether it claimed. Of claims racing on one challenge exactly one wins, whatever installation each names.
 */
export async function claimPasskeySignIn(db: Db, { credentialId, challenge, challengeIssuedAt, isNewDevice }: PasskeySignInClaim): Promise<boolean> {
  if (!isAuthKey(credentialId) || !isAuthKey(challenge) || typeof challengeIssuedAt !== 'number' || !Number.isFinite(challengeIssuedAt)) return false;
  const filter = { _id: credentialId, 'signIns.challenge': { $ne: challenge }, ...(isNewDevice === true ? { revokedAt: { $exists: false } } : {}) };
  const update = { $push: { signIns: { $each: [{ challenge, issuedAt: challengeIssuedAt }], $sort: { issuedAt: 1 }, $slice: -MAX_CLAIMED_SIGN_INS } } };
  try {
    // The first sign-in of a passkey creates its document. When the document exists but the filter fails (claimed, or
    // revoked), the upsert's insert breaks the _id index instead: refused, as wanted.
    await passkeys(db).updateOne(filter as never, update as never, { upsert: true });
    return true;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
  // Two first-ever claims (different challenges) can race to insert the document; the loser re-runs the claim on the
  // document that now exists, which answers correctly.
  const { matchedCount } = await passkeys(db).updateOne(filter as never, update as never);
  return matchedCount === 1;
}

/**
 * Marks passkeys revoked (sc-645): one of their devices is being disabled or deleted. Keeps the earliest time, and never
 * clears the mark, so neither deleting nor re-enabling that device lifts it. Called BEFORE the device write, so a failure
 * between the two leaves the passkey revoked (fail closed), never the device gone and the passkey not revoked.
 */
export async function revokePasskeys(db: Db, credentialIds: string[], now: number): Promise<void> {
  const ids = [...new Set(credentialIds.filter(id => isAuthKey(id)))];
  if (ids.length === 0) return;
  await passkeys(db).bulkWrite(ids.map(id => ({ updateOne: { filter: { _id: id }, update: { $min: { revokedAt: now } }, upsert: true } })), { ordered: false });
}

/** Whether a device of this passkey was ever disabled, signed out or deleted. A key that is not a string is not revoked. */
export async function isPasskeyRevoked(db: Db, credentialId: string): Promise<boolean> {
  if (!isAuthKey(credentialId)) return false;
  return (await passkeys(db).countDocuments({ _id: credentialId, revokedAt: { $exists: true } }, { limit: 1 })) === 1;
}
