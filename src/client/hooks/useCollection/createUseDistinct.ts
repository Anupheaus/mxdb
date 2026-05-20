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
      distinct(field, fields => setState({ values: fields as DistinctField[], isLoading: false, error: undefined }));
    }, [field]);

    return getState();
  };
}
