// Loads the `@anupheaus/common` global extensions (`Object.clone`, `Date.isIsoString`) used below.
import '@anupheaus/common';
import type { Record } from '@anupheaus/common';
import { DateTime } from 'luxon';
import type { MongoDocOf } from '../../../common';
import type { WithId } from 'mongodb';

// Stored MongoDB documents represent Luxon `DateTime` values as native BSON `Date`s (absolute
// instants) — NOT ISO strings. This is what keeps range queries working: the query path
// (`ServerDbCollection.#parseFilters`) converts `DateTime` filter bounds to `Date`, and MongoDB
// only compares values of the same BSON type (a `Date` filter never matches a stored `string`).
// On read we revive `Date`s (and any legacy ISO-string dates from before this was fixed) back
// into `DateTime`s for the domain models.

function serialize<RecordType extends Record>({ id, ...doc }: RecordType): MongoDocOf<RecordType> {
  return Object.clone({ ...doc, _id: id }, value =>
    (DateTime.isDateTime(value) ? value.toJSDate() : value)) as unknown as MongoDocOf<RecordType>;
}

function deserialize<RecordType extends Record>(record: MongoDocOf<RecordType> | WithId<MongoDocOf<RecordType>> | undefined): RecordType | undefined {
  if (record == null) return;
  const { _id, ...doc } = record;
  return Object.clone({ ...doc, id: _id }, value => {
    if (value instanceof Date) return DateTime.fromJSDate(value);
    // Legacy: dates written as ISO strings before BSON-Date storage was restored.
    if (typeof value === 'string' && Date.isIsoString(value)) return DateTime.fromISO(value);
    return value;
  }) as unknown as RecordType;
}

export const dbUtils = {
  deserialize,
  serialize,
};
