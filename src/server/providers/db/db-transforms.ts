// Loads the `@anupheaus/common` global extensions (`Object.clone`, `Date.isIsoString`) used below.
import '@anupheaus/common';
import type { Record } from '@anupheaus/common';
import { DateTime } from 'luxon';
import type { MongoDocOf } from '../../../common';
import { BSON, type WithId } from 'mongodb';
import { hashRecord } from '../../../common/auditor/hash';

// Stored MongoDB documents represent Luxon `DateTime` values as native BSON `Date`s (absolute
// instants) — NOT ISO strings. This is what keeps range queries working: the query path
// (`ServerDbCollection.#parseFilters`) converts `DateTime` filter bounds to `Date`, and MongoDB
// only compares values of the same BSON type (a `Date` filter never matches a stored `string`).
// On read we revive `Date`s (and any legacy ISO-string dates from before this was fixed) back
// into `DateTime`s for the domain models.

/**
 * Storage-only metadata persisted alongside the live document under `_meta`. It is never part of the
 * domain record — `deserialize` strips it. `hash` is the record's content hash, computed over the
 * READ-BACK form so it always equals `hashRecord(deserialize(storedDoc))`. This lets the C2S sync
 * compare hashes by projecting `_meta` instead of fetching and re-hashing the whole record.
 */
export interface MXDBStoredMeta {
  hash: string;
  /** Max audit-entry id at write time — lets the C2S mismatch path build a cursor without fetching the audit. */
  lastAuditEntryId?: string;
}

function serialize<RecordType extends Record>({ id, ...doc }: RecordType): MongoDocOf<RecordType> {
  return Object.clone({ ...doc, _id: id }, value =>
    (DateTime.isDateTime(value) ? value.toJSDate() : value)) as unknown as MongoDocOf<RecordType>;
}

function deserialize<RecordType extends Record>(record: MongoDocOf<RecordType> | WithId<MongoDocOf<RecordType>> | undefined): RecordType | undefined {
  if (record == null) return;
  const { _id, ...doc } = record as WithId<MongoDocOf<RecordType>> & { _meta?: MXDBStoredMeta };
  delete (doc as { _meta?: MXDBStoredMeta })._meta; // storage-only — never surfaced on the domain record
  return Object.clone({ ...doc, id: _id }, value => {
    if (value instanceof Date) return DateTime.fromJSDate(value);
    // Legacy: dates written as ISO strings before BSON-Date storage was restored.
    if (typeof value === 'string' && Date.isIsoString(value)) return DateTime.fromISO(value);
    return value;
  }) as unknown as RecordType;
}

/**
 * Serialize a record AND attach `_meta`. The hash is computed over the read-back form
 * (`deserialize(serialize(record))`) so the stored `_meta.hash` is guaranteed identical to what a
 * later `hashRecord(deserialize(storedDoc))` would produce — the invariant the C2S comparison relies on.
 */
async function serializeWithMeta<RecordType extends Record>(record: RecordType, lastAuditEntryId?: string): Promise<MongoDocOf<RecordType>> {
  const doc = serialize(record);
  const hash = await hashRecord(deserialize(doc) as Record);
  const meta: MXDBStoredMeta = { hash };
  if (lastAuditEntryId != null) meta.lastAuditEntryId = lastAuditEntryId;
  return { ...doc, _meta: meta } as unknown as MongoDocOf<RecordType>;
}

/**
 * A stored document's `_meta.hash` when it no longer describes the document's content, else `undefined` (it matches,
 * or there is none). Only a write that bypassed mxdb leaves one behind: a fix by hand or a migration that changed the
 * document but not its `_meta`, or copied an old `_meta` into a replacement.
 */
async function staleStoredHashOf(storedDocument: MongoDocOf<Record>): Promise<string | undefined> {
  const storedHash = (storedDocument as { _meta?: Partial<MXDBStoredMeta> })._meta?.hash;
  if (storedHash == null) return;
  const contentHash = await hashRecord(deserialize(storedDocument) as Record);
  return contentHash === storedHash ? undefined : storedHash;
}

/**
 * Whether a stored document was written without mxdb: every mxdb write stores a `_meta.hash` describing the content, so a
 * document with none, or with one that no longer describes it, was written by something else (a fix by hand, a migration,
 * a script that removed `_meta` as the documented route for a server that is stopped).
 */
async function isWrittenWithoutMxdb(storedDocument: MongoDocOf<Record>): Promise<boolean> {
  if ((storedDocument as { _meta?: Partial<MXDBStoredMeta> })._meta?.hash == null) return true;
  return await staleStoredHashOf(storedDocument) != null;
}

/**
 * `record` exactly as it reads back once stored: the same BSON round trip the driver makes (an `undefined` field comes back
 * as `null`, for example). Lets a record rebuilt from its history be compared with a stored one by what storing it would
 * change, not by how each was made.
 */
function asStored<RecordType extends Record>(record: RecordType): RecordType {
  // `ignoreUndefined: false` is the driver's own default (BSON's is the opposite).
  return deserialize(BSON.deserialize(BSON.serialize(serialize(record), { ignoreUndefined: false })) as MongoDocOf<RecordType>) as RecordType;
}

export const dbUtils = {
  asStored,
  deserialize,
  isWrittenWithoutMxdb,
  serialize,
  serializeWithMeta,
  staleStoredHashOf,
};
