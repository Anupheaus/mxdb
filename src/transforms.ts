import type { Record } from '@anupheaus/common';
import { DateTime } from 'luxon';

export function serialise<RecordType extends Record>(record: RecordType): RecordType {
  return Object.clone(record, value => {
    if (value instanceof Date) return value.toISOString();
    if (DateTime.isDateTime(value)) return value.toISO();
    return value;
  });
}

export function deserialise<RecordType extends Record>(record: RecordType): RecordType {
  return Object.clone(record, value => {
    if (typeof value === 'string' && Date.isIsoString(value)) return DateTime.fromISO(value);
    return value;
  });
}
