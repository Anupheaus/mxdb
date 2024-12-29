import type { PromiseMaybe, Record } from '@anupheaus/common';
import type { QueryProps, QueryResponse } from './createQuery';
import type { DistinctProps } from './createDistinct';
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

export { QueryProps, QueryResponse, DistinctProps };
