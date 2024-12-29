import { useLayoutEffect, useState } from 'react';
import type { Record } from '@anupheaus/common';
import { useOnUnmount } from '@anupheaus/react-ui';
import type { Distinct, DistinctProps } from './createDistinct';

interface State<T = unknown> {
  values: T[];
  isLoading: boolean;
  error?: Error;
}

export function createUseDistinct<RecordType extends Record>(distinct: Distinct<RecordType>) {
  return function useDistinct<T = unknown>(props: DistinctProps<RecordType>) {
    const [state, setState] = useState<State<T>>({ values: [], isLoading: true });
    const isUnmounted = useOnUnmount();

    useLayoutEffect(() => {
      (async () => {
        setState(s => ({ ...s, isLoading: true }));
        await distinct<T>(props, values => {
          if (isUnmounted()) return;
          setState({ values, isLoading: false });
        });
      })();
    }, [Object.hash(props)]);

    return state;
  };
}