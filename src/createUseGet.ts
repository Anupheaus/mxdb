import { useLayoutEffect, useMemo } from 'react';
import type { Get } from './createGet';
import type { Record } from '@anupheaus/common';
import { useSyncState } from '@anupheaus/react-ui';
import { useDb } from './DbContext';

interface State<RecordType extends Record> {
  record?: RecordType;
  isLoading: boolean;
  error?: Error;
}

export function createUseGet<RecordType extends Record>(name: string, get: Get<RecordType>, dbName?: string) {
  const { onCollectionEvent } = useDb(dbName);

  return function useGet(id: string | undefined) {
    const { setState, getState } = useSyncState<State<RecordType>>(() => ({ record: undefined, isLoading: id != null }));

    useMemo(() => {
      const state = getState();
      if (id == null) {
        if (state.record != null) {
          setState({ record: undefined, isLoading: false, error: undefined });
        }
      } else {
        if (state.record?.id !== id) {
          setState({ record: undefined, isLoading: true, error: undefined });
        }
      }
    }, [id]);

    useLayoutEffect(() => {
      (async () => {
        if (id == null) {
          setState({ record: undefined, isLoading: false });
        } else {
          const currentState = getState();
          if (currentState.record?.id === id) return;

          setState({ record: undefined, isLoading: true, error: undefined });
          const record = await get(id);
          setState({ record, isLoading: false });
        }
      })();

      return onCollectionEvent<RecordType>(name, ({ type, records }) => {
        if (id == null) return; // can't check that this is to do with us
        const record = records.findById(id);
        if (record == null) return; // this event is not for this id
        switch (type) {
          case 'upsert': setState({ record, isLoading: false }); break;
          case 'remove': setState({ record: undefined, isLoading: false }); break;
        }
      });
    }, [id]);

    return getState();
  };
}