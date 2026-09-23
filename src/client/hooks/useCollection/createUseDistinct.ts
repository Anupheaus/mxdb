import { useLayoutEffect } from 'react';
import { type Record } from '@anupheaus/common';
import type { Distinct } from './createDistinct';
import { useSyncState } from '@anupheaus/react-ui';
import type { MXDBError } from '../../../common';

export interface DistinctState<DistinctField> {
  values: DistinctField[];
  isLoading: boolean;
  error?: MXDBError;
}

export function createUseDistinct<RecordType extends Record>(distinct: Distinct<RecordType>) {

  return <Field extends keyof RecordType, DistinctField extends RecordType[Field]>(field: Field) => {
    const { getState, setState } = useSyncState<DistinctState<DistinctField>>(() => ({ values: [], isLoading: true, error: undefined }));

    useLayoutEffect(() => {
      setState(s => ({ ...s, isLoading: true }));
      // Shared by the initial run (its rejected promise) and the reactive re-runs (collection change /
      // subscription update), so a failure surfaces identically whichever run hit it: last values kept, error set.
      const onError = (error: unknown) => {
        console.error('[MXDB] useDistinct threw', { field, error }); // eslint-disable-line no-console
        setState(s => ({ ...s, isLoading: false, error: error as MXDBError }));
      };
      distinct({ field }, {
        onResponse: fields => setState({ values: fields as DistinctField[], isLoading: false, error: undefined }),
        onError,
      }).catch(onError);
    }, [field]);

    return getState();
  };
}
