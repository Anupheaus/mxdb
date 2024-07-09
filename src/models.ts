import { Record } from '@anupheaus/common';

export interface MXDBCollection<RecordType extends Record = any> {
  name: string;
  type: RecordType;
  sortableFields: (keyof RecordType)[];
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
}
