import type { DataFilters, Logger, Record } from '@anupheaus/common';
import { is, SortDirections } from '@anupheaus/common';
import type { CollectionEvent } from './DbContext';
import { useDb } from './DbContext';
import type { Query as Filter } from 'sift';
import sift from 'sift';
import type { MXDBCollection, MXDBCollectionConfig, SortableField } from './models';
import { utils } from './utils';
import { DateTime } from 'luxon';
import { useRef } from 'react';
import { useOnUnmount } from '@anupheaus/react-ui';
import { deserialise } from './transforms';

export interface QueryProps<RecordType extends Record> {
  filter?: DataFilters<RecordType>;
  sort?: SortableField<RecordType>;
  pagination?: {
    limit: number;
    offset?: number;
  };
  disable?: boolean;
}

export interface QueryResponse<RecordType extends Record> {
  records: RecordType[];
  total: number;
}

export function createQuery<RecordType extends Record>(collection: MXDBCollection<RecordType>, config: MXDBCollectionConfig<RecordType>, dbName: string | undefined, logger: Logger) {
  const { db, onCollectionEvent } = useDb(dbName);
  const handleCollectionEventRef = useRef<(event: CollectionEvent<RecordType>) => void>();
  const unsubscribeFomCollectionEventsRef = useRef<() => void>(() => void 0);
  const haveSignedUpToCollectionEventsRef = useRef(false);
  const onRead = config.onRead ?? (records => records);

  const signUpToCollectionEvents = () => {
    if (haveSignedUpToCollectionEventsRef.current) return;
    haveSignedUpToCollectionEventsRef.current = true;
    unsubscribeFomCollectionEventsRef.current = onCollectionEvent<RecordType>(collection.name, event => {
      if (handleCollectionEventRef.current) handleCollectionEventRef.current(event);
    });
  };

  useOnUnmount(() => unsubscribeFomCollectionEventsRef.current());

  return async (props?: QueryProps<RecordType>, response?: (response: QueryResponse<RecordType>) => void) => {
    logger.debug(`Querying collection "${collection.name}"...`, props);
    const { filter, pagination, sort, disable = false } = props ?? {};
    if (response != null) signUpToCollectionEvents();

    const processRecords = async () => {
      if (disable) return { records: [], total: 0 };
      const transaction = db.transaction(collection.name, 'readonly');
      const store = transaction.objectStore(collection.name);
      let records = await onRead((await utils.wrap<RecordType[]>(store.getAll())).map(deserialise));
      transaction.commit();
      const startTime = DateTime.now();
      if (filter != null) records = records.filter(sift(filter as Filter<RecordType>));
      if (sort) {
        const field = is.plainObject(sort) ? sort.field : sort;
        const direction = (is.plainObject(sort) ? sort.direction : 'asc') ?? 'asc';
        records = records.orderBy(record => record[field], direction === 'desc' ? SortDirections.Descending : SortDirections.Ascending);
      }
      const total = records.length;
      if (pagination) {
        const start = pagination.offset ?? 0;
        const end = start + pagination.limit;
        records = records.slice(start, end);
      }
      const timeTaken = DateTime.now().diff(startTime).milliseconds;
      if (timeTaken > 1500) {
        logger.warn(`Query on collection "${collection.name}" took ${timeTaken}ms`, props);
      } else {
        logger.debug(`Query on collection "${collection.name}" completed (time taken: ${timeTaken}ms).`);
      }
      if (disable) return { records: [], total: 0 };
      return { records, total };
    };

    let { records, total } = await processRecords();

    if (response != null) {
      response({ records, total });
      handleCollectionEventRef.current = async () => {
        const { records: newRecords, total: newTotal } = await processRecords();
        if (newTotal !== total || !is.deepEqual(records, newRecords)) {
          records = newRecords;
          total = newTotal;
          response({ records: newRecords, total: newTotal });
        }
      };
    } else {
      handleCollectionEventRef.current = undefined;
    }

    return {
      records,
      total,
    };
  };
}

export type Query<RecordType extends Record> = ReturnType<typeof createQuery<RecordType>>;
