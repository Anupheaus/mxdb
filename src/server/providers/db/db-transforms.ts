// Loads the `@anupheaus/common` global extensions (`Object.clone`, `Date.isIsoString`) used below.
import '@anupheaus/common';
import type { Record } from '@anupheaus/common';
import { DateTime } from 'luxon';
import type { MongoDocOf } from '../../../common';
import type { WithId } from 'mongodb';
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
async function serializeWithMeta<RecordType extends Record>(record: RecordType): Promise<MongoDocOf<RecordType>> {
  const doc = serialize(record);
  const hash = await hashRecord(deserialize(doc) as Record);
  return { ...doc, _meta: { hash } } as unknown as MongoDocOf<RecordType>;
}

export const dbUtils = {
  deserialize,
  serialize,
  serializeWithMeta,
};
