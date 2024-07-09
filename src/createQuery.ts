import { is, Logger, Record, SortDirections } from '@anupheaus/common';
import { useDb } from './DbContext';
import sift, { Query as Filter } from 'sift';
import { MXDBCollection } from './models';
import { utils } from './utils';
import { DateTime } from 'luxon';

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

export function createQuery<RecordType extends Record>(collection: MXDBCollection<RecordType>, logger: Logger) {
  const { db } = useDb();
  return async (props: QueryProps<RecordType>) => {
    logger.debug(`Querying collection "${collection.name}"...`, props);
    const { filter, pagination, sort } = props;
    const transaction = db.transaction(collection.name, 'readonly');
    const store = transaction.objectStore(collection.name);
    const startTime = DateTime.now();
    let records = await utils.wrap<RecordType[]>(store.getAll());
    records = records.filter(sift(filter));
    if (sort) {
      const field = is.plainObject(sort) ? sort.field : sort;
      const direction = is.plainObject(sort) ? sort.direction : 'asc';
      records = records.orderBy(record => record[field], direction === 'asc' ? SortDirections.Ascending : SortDirections.Descending);
    }
    if (pagination) records = records.slice(pagination.offset ?? 0, pagination.limit);
    const timeTaken = DateTime.now().diff(startTime).milliseconds;
    if (timeTaken > 1500) logger.warn(`Query on collection "${collection.name}" took ${timeTaken}ms`, props);
    logger.debug(`Query on collection "${collection.name}" completed (time taken: ${timeTaken}ms).`);
    return records;
  };
}

export type Query<RecordType extends Record> = ReturnType<typeof createQuery<RecordType>>;
