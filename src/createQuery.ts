import { is, Record, SortDirections } from '@anupheaus/common';
import { useDb } from './DbContext';
import sift, { Query as Filter } from 'sift';
import { Collection } from './models';
import { utils } from './utils';

// type GetSortableFieldsFrom<T extends Collection<any>> = { sortBy: T['sortableFields'][number]; direction?: 'asc' | 'desc'; };
type SortableField<RecordType extends Record> = keyof RecordType | ({
  field: keyof RecordType;
  direction?: 'asc' | 'desc';
});

export interface QueryProps<RecordType extends Record> {
  filter: Filter<RecordType>;
  sort?: SortableField<RecordType>;
  pagination?: {
    limit: number;
    offset?: number;
  };
}

export function createQuery<RecordType extends Record>(collection: Collection<RecordType>) {
  const { db } = useDb();
  return async ({ filter, pagination, sort }: QueryProps<RecordType>) => {
    const transaction = db.transaction(collection.name, 'readonly');
    const store = transaction.objectStore(collection.name);
    let records = await utils.wrap<RecordType[]>(store.getAll());
    records = records.filter(sift(filter));
    if (sort) {
      const field = is.plainObject(sort) ? sort.field : sort;
      const direction = is.plainObject(sort) ? sort.direction : 'asc';
      records = records.orderBy(record => record[field], direction === 'asc' ? SortDirections.Ascending : SortDirections.Descending);
    }
    if (pagination) records = records.slice(pagination.offset ?? 0, pagination.limit);
    return records;
  };
}

export type Query<RecordType extends Record> = ReturnType<typeof createQuery<RecordType>>;
