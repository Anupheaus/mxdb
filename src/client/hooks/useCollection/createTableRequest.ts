import type { DataFilters, Record } from '@anupheaus/common';
import type { Query } from './createQuery';
import type { TableOnRequest } from '@anupheaus/react-ui';
import { useBound, useDebounce } from '@anupheaus/react-ui';

export interface TableRequestProps {
  debounceTimer?: number;
}

export function createTableRequest<RecordType extends Record>(query: Query<RecordType>) {
  return useBound(({ debounceTimer = 200 }: TableRequestProps = {}): TableOnRequest<RecordType> => useDebounce(async ({ requestId, ...request }, onResponse) => {
    const filters = {} as DataFilters<RecordType>;
    query({ filters, sorts: 'id', ...request }, response => onResponse({ ...response, requestId }));
  }, debounceTimer));
}
