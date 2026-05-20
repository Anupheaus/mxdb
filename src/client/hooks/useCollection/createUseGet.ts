import { useLayoutEffect, useMemo } from 'react';
import type { Record } from '@anupheaus/common';
import { useSyncState } from '@anupheaus/react-ui';
import { useNexus } from '@anupheaus/nexus/client';
import type { DbCollection } from '../../providers';
import type { Get } from './createGet';
import type { MXDBError } from '../../../common';

export interface State<RecordType extends Record> {
  record?: RecordType;
  isLoading: boolean;
  error?: MXDBError;
}

export function createUseGet<RecordType extends Record>(collection: DbCollection<RecordType>, get: Get<RecordType>) {
  return (id: string | undefined) => {
    const { setState, getState } = useSyncState<State<RecordType>>(() => ({ record: undefined, isLoading: id != null, error: undefined }));
    // Re-run the fetch effect when the socket (re)connects. Without this, an initial
    // get() call that runs while the socket is still handshaking silently returns
    // no record (createGet falls through its `getIsConnected()` gate) and useGet
    // parks at { record: undefined, isLoading: false } forever.
    const { isConnected } = useNexus();

    useMemo(() => {
      const state = getState();
      if (id == null) {
        if (state.record != null) {
          setState({ record: undefined, isLoading: false, error: undefined });
        }
      } else {
        if (state.record?.id !== id) {
          setState(s => ({ ...s, isLoading: true }));
        }
      }
    }, [id]);

    useLayoutEffect(() => {
      (async () => {
        if (id == null) {
          setState({ record: undefined, isLoading: false, error: undefined });
        } else {
          const currentState = getState();
          if (currentState.record?.id === id) return;

          setState(s => ({ ...s, isLoading: true }));
          try {
            const record = await get(id);
            setState({ record, isLoading: false, error: undefined });
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error('[MXDB] createUseGet: get() threw an error for id', id, error);
            setState(s => ({ ...s, isLoading: false, error: error as MXDBError }));
          }
        }
      })();

      return collection.onChange(event => {
        if (id == null) return;
        switch (event.type) {
          case 'upsert': {
            const record = event.records.findById(id);
            if (record == null) return;
            setState({ record, isLoading: false, error: undefined });
            break;
          }
          case 'remove': {
            if (!event.ids.includes(id)) return;
            setState({ record: undefined, isLoading: false, error: undefined });
            break;
          }
        }
      });
    }, [id, isConnected]);

    return getState();
  };
}