import { useLayoutEffect, useRef, useState } from 'react';
import { Record } from '@anupheaus/common';
import { useDb } from './DbContext';
import { Query, QueryProps } from './createQuery';
import { useOnUnmount } from '@anupheaus/react-ui';

interface State<RecordType extends Record> {
  records: RecordType[];
  isLoading: boolean;
  error?: Error;
}

export function createUseQuery<RecordType extends Record>(name: string, query: Query<RecordType>) {
  const { onCollectionEvent } = useDb();

  return function useQuery(props: QueryProps<RecordType>) {
    const [state, setState] = useState<State<RecordType>>({ records: [], isLoading: true });
    const idsRef = useRef<string[]>([]);
    const isUnmounted = useOnUnmount();

    useLayoutEffect(() => {
      const getRecords = async () => {
        setState(s => ({ ...s, isLoading: true }));
        const records = await query(props);
        if (isUnmounted()) return;
        idsRef.current = records.ids();
        setState({ records, isLoading: false });
      };
      getRecords();

      return onCollectionEvent<RecordType>(name, ({ type, record }) => {
        switch (type) {
          case 'upsert': {
            getRecords();
            break;
          }
          case 'remove': {
            if (!idsRef.current.includes(record.id)) return;
            setState(s => {
              const newRecords = s.records.removeById(record.id);
              idsRef.current = newRecords.ids();
              return {
                ...s,
                records: newRecords,
              };
            });
            break;
          }
        }
      });
    }, [Object.hash(props)]);

    return state;
  };
}