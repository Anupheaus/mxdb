import { useLayoutEffect, useRef } from 'react';
import type { Record } from '@anupheaus/common';
import { useSyncState } from '@anupheaus/react-ui';
import type { MXDBError } from '../../../common';
import type { AddDebugTo, AddDisableTo } from '../../../common/models';
import type { GetAll } from './createGetAll';

export function createUseGetAll<RecordType extends Record>(getAll: GetAll<RecordType>) {
  return (props: AddDebugTo<AddDisableTo<object>> = {}) => {
    const { setState, getState } = useSyncState(() => ({ records: [] as RecordType[], isLoading: true, error: undefined as MXDBError | undefined }));
    const lastResponseRef = useRef<Partial<ReturnType<typeof getState>>>();
    const requestIdRef = useRef('');

    useLayoutEffect(() => {
      if (props.disable) {
        if (props.debug) console.log('[MXDB] getAll is disabled, returning default', props); // eslint-disable-line no-console
        setState({ records: [], isLoading: false, error: undefined });
      } else {
        setState(s => ({ ...s, isLoading: true }));
        const requestId = requestIdRef.current = Math.uniqueId();
        if (props.debug) console.log('[MXDB] Subscribing getAll', { requestId, props }); // eslint-disable-line no-console
        getAll(props, records => {
          if (props.debug) console.log('[MXDB] getAll response', { requestId, count: records.length }); // eslint-disable-line no-console
          if (requestId !== requestIdRef.current) return;
          lastResponseRef.current = { records };
          setState({ records, isLoading: false, error: undefined });
        }, () => setState(s => ({ ...s, ...lastResponseRef.current, isLoading: false })));
      }
    }, [Object.hash(props)]);

    return getState();
  };
}
