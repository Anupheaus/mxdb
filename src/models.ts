import { PromiseMaybe, Record } from '@anupheaus/common';

export interface Collection<RecordType extends Record = any> {
  name: string;
  type: RecordType;
  sortableFields: (keyof RecordType)[];
}

export interface CollectionIndex<RecordType extends Record = Record> {
  name?: string;
  fields: (keyof RecordType)[];
  isUnique?: boolean;
}

export interface CollectionConfig<RecordType extends Record = Record> {
  name: string;
  version: number;
  indexes: CollectionIndex<RecordType>[];
  onUpgrade?(prevVersion: number, records: RecordType[]): RecordType[];
  onSeed?(): PromiseMaybe<void>;
}
