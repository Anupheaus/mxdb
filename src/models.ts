import type { PromiseMaybe, Record } from '@anupheaus/common';
import { QueryProps, QueryResponse } from './createQuery';
export interface MXDBCollection<RecordType extends Record = any> {
  name: string;
  type: RecordType;
}

export interface MXDBCollectionIndex<RecordType extends Record = Record> {
  name?: string;
  fields: (keyof RecordType)[];
  isUnique?: boolean;
}

export interface MXDBCollectionConfig<RecordType extends Record = Record> {
  name: string;
  version: number;
  indexes: MXDBCollectionIndex<RecordType>[];
  onUpgrade?(prevVersion: number, records: RecordType[]): RecordType[];
  onWrite?(records: RecordType[]): PromiseMaybe<RecordType[]>;
  onRead?(records: RecordType[]): PromiseMaybe<RecordType[]>;
}

type KeyOf<RecordType extends Record> = keyof RecordType extends string ? keyof RecordType : never;

export type SortableField<RecordType extends Record> = KeyOf<RecordType> | ({
  field: KeyOf<RecordType>;
  direction?: 'asc' | 'desc';
});

export { QueryProps, QueryResponse };
