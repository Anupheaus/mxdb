import { useLayoutEffect, useState } from 'react';
import type { Record } from '@anupheaus/common';
import type { Query, QueryProps } from './createQuery';
import { useOnUnmount } from '@anupheaus/react-ui';

interface State<RecordType extends Record> {
  records: RecordType[];
  total: number;
  isLoading: boolean;
  error?: Error;
}

export function createUseQuery<RecordType extends Record>(query: Query<RecordType>) {
  return function useQuery(props: QueryProps<RecordType>) {
    const [state, setState] = useState<State<RecordType>>({ records: [], total: 0, isLoading: true });
    const isUnmounted = useOnUnmount();

    useLayoutEffect(() => {
      (async () => {
        setState(s => ({ ...s, isLoading: true }));
        await query(props, ({ records, total }) => {
          if (isUnmounted()) return;
          setState({ records, total, isLoading: false });
        });
      })();
    }, [Object.hash(props)]);

    return state;
  };
}