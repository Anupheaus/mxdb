import { useMemo, useRef } from 'react';
import type { Logger, Record } from '@anupheaus/common';
import type { Query } from './createQuery';
import { useSyncState } from '@anupheaus/react-ui';
import type { QueryProps } from '../../../common';
import type { MXDBError } from '../../../common';
import type { AddDebugTo, AddDisableTo } from '../../../common/models';

export function createUseQuery<RecordType extends Record>(query: Query<RecordType>, logger: Logger) {

  return (props: AddDebugTo<AddDisableTo<QueryProps<RecordType>>> = {}) => {
    const { setState, getState } = useSyncState(() => ({ records: [] as RecordType[], total: 0, isLoading: true, error: undefined as MXDBError | undefined }));
    const lastResponseRef = useRef<Partial<ReturnType<typeof getState>>>();
    const requestIdRef = useRef('');

    useMemo(() => {
      if (props.disable) {
        if (props.debug) logger.debug('useQuery disabled', { props });
        setState({ records: [], total: 0, isLoading: false, error: undefined });
      } else {
        setState(s => ({ ...s, isLoading: true }));
        const requestId = requestIdRef.current = Math.uniqueId();
        if (props.debug) logger.debug('useQuery send', { requestId, props });
        // Shared by the initial run (its rejected promise) and the reactive re-runs (collection change /
        // subscription update), so a failure surfaces identically whichever run hit it: last records kept, error set.
        const onError = (error: unknown) => {
          logger.error('useQuery threw', { props, error: error instanceof Error ? error.message : String(error) });
          if (requestId !== requestIdRef.current) return;
          setState(s => ({ ...s, isLoading: false, error: error as MXDBError }));
        };
        query(props, {
          onResponse: ({ records, total }) => {
            if (props.debug) logger.debug('useQuery response', { requestId, count: records.length, total });
            if (requestId !== requestIdRef.current) return;
            lastResponseRef.current = { records, total }; // store the last response to be used when the query is disabled and then the same props are passed again, the onSameResponse callback will be called
            setState({ records, total, isLoading: false, error: undefined });
          },
          onSameResponse: () => setState(s => ({ ...s, ...lastResponseRef.current, isLoading: false })),
          onError,
        }).catch(onError);
      }
    }, [Object.hash(props)]);

    return getState();
  };
}