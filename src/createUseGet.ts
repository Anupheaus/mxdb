import { useLayoutEffect, useState } from 'react';
import { Get } from './createGet';
import { Record } from '@anupheaus/common';
import { useDb } from './DbContext';

interface State<RecordType extends Record> {
  record?: RecordType;
  isLoading: boolean;
  error?: Error;
}

export function createUseGet<RecordType extends Record>(name: string, get: Get<RecordType>) {
  const { onCollectionEvent } = useDb();
  return function useGet(id: string | undefined) {
    const [state, setState] = useState<State<RecordType>>({ record: undefined, isLoading: id != null });

    useLayoutEffect(() => {
      (async () => {
        if (id == null) {
          setState({ record: undefined, isLoading: false });
        } else {
          setState({ record: undefined, isLoading: true });
          const record = await get(id);
          setState({ record, isLoading: false });
        }
      })();

      return onCollectionEvent<RecordType>(name, ({ type, record }) => {
        if (record.id !== id) return;
        switch (type) {
          case 'upsert': setState({ record, isLoading: false }); break;
          case 'remove': setState({ record: undefined, isLoading: false }); break;
        }
      });
    }, [id]);

    return state;
  };
}