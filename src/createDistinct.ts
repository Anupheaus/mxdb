import type { DataRequest, Logger, Record } from '@anupheaus/common';
import { DataSorts } from '@anupheaus/common';
import { is, SortDirections } from '@anupheaus/common';
import type { CollectionEvent } from './DbContext';
import { useDb } from './DbContext';
import type { Query as Filter } from 'sift';
import sift from 'sift';
import type { MXDBCollection, MXDBCollectionConfig } from './models';
import { utils } from './utils';
import { DateTime } from 'luxon';
import { useRef } from 'react';
import { useOnUnmount } from '@anupheaus/react-ui';
import { deserialise } from './transforms';

export interface DistinctProps<RecordType extends Record> extends Omit<DataRequest<RecordType>, 'pagination'> {
  field: keyof RecordType;
  disable?: boolean;
}

export function createDistinct<RecordType extends Record>(collection: MXDBCollection<RecordType>, config: MXDBCollectionConfig<RecordType>, dbName: string | undefined, logger: Logger) {
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

  return async <T = unknown>(propsOrField: DistinctProps<RecordType> | keyof RecordType, response?: (values: T[]) => void) => {
    const props = (is.string(propsOrField) ? { field: propsOrField } : propsOrField) as DistinctProps<RecordType>;
    logger.debug(`Querying collection "${collection.name}"...`, props);
    const { filters, field, sorts, disable = false } = props;
    if (response != null) signUpToCollectionEvents();

    const processRecords = async (): Promise<T[]> => {
      if (disable) return [];
      const transaction = db.transaction(collection.name, 'readonly');
      const store = transaction.objectStore(collection.name);
      let records = await onRead((await utils.wrap<RecordType[]>(store.getAll())).map(deserialise));
      transaction.commit();
      const startTime = DateTime.now();
      if (filters != null) records = records.filter(sift(filters as Filter<RecordType>));
      if (sorts) {
        const strictSorts = DataSorts.toArray(sorts);
        strictSorts.forEach(sort => {
          records = records.orderBy(record => record[sort[0]], sort[1] === 'desc' ? SortDirections.Descending : SortDirections.Ascending);
        });
      }
      const values = records.map(record => record[field] as T);
      const timeTaken = DateTime.now().diff(startTime).milliseconds;
      if (timeTaken > 1500) {
        logger.warn(`Query on collection "${collection.name}" took ${timeTaken}ms`, props);
      } else {
        logger.debug(`Query on collection "${collection.name}" completed (time taken: ${timeTaken}ms).`);
      }
      if (disable) return [];
      return values;
    };

    let values = await processRecords();

    if (response != null) {
      response(values);
      handleCollectionEventRef.current = async () => {
        const newValues = await processRecords();
        if (!is.deepEqual(values, newValues)) {
          values = newValues;
          response(values);
        }
      };
    } else {
      handleCollectionEventRef.current = undefined;
    }

    return values;
  };
}

export type Distinct<RecordType extends Record> = ReturnType<typeof createDistinct<RecordType>>;
