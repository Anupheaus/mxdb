import { is, type Logger, type Record } from '@anupheaus/common';
import type { QueryProps, QueryRequest } from '../../../common';
import { mxdbQueryAction, mxdbQuerySubscription } from '../../../common';
import { useRef } from 'react';
import type { UseSubscription } from './createUseSubscription';
import type { DbCollection } from '../../providers';
import { useSubscriptionWrapper } from './useSubscriptionWrapper';
import type { AddDebugTo, AddDisableTo } from '../../../common/models';

export interface QueryResponse<RecordType extends Record> {
  records: RecordType[];
  total: number;
}

export function createQuery<RecordType extends Record>(collection: DbCollection<RecordType>, useSubscription: UseSubscription, logger: Logger) {
  const serverTotalRef = useRef<number>();
  const wrapper = useSubscriptionWrapper<RecordType, AddDebugTo<QueryProps<RecordType>>, QueryResponse<RecordType>, QueryRequest, number>({
    subscription: mxdbQuerySubscription,
    action: mxdbQueryAction,
    collection,
    logger,
    slowThreshold: 1500,
    useSubscription,
    onDefaultResponse: () => ({ records: [], total: 0 }),
    async onExecute(request) {
      let { records, total } = await collection.query(request);
      // Prefer the server's total when known; otherwise use the local total from collection.query — which is
      // records.length for a full result and the COUNT(*) for a paginated one, so offline pagination stays correct.
      total = serverTotalRef.current ?? total;
      return { records, total };
    },
    onRequestTransform: request => ({ ...request as QueryProps<Record>, collectionName: collection.name }),
    onOfflineAction() { serverTotalRef.current = undefined; },
    onRemoteDefaultResponse: () => -1,
    onRemoteResponse(total) { serverTotalRef.current = total < -1 ? undefined : total; },
  });

  function queryWrapper(props?: AddDebugTo<AddDisableTo<QueryProps<RecordType>>>): Promise<QueryResponse<RecordType>>;
  function queryWrapper(props: AddDebugTo<AddDisableTo<QueryProps<RecordType>>>, onResponse: (result: QueryResponse<RecordType>) => void): Promise<void>;
  function queryWrapper(props: AddDebugTo<AddDisableTo<QueryProps<RecordType>>>, onResponse: (result: QueryResponse<RecordType>) => void, onSameResponse: () => void): Promise<void>;
  /** `onError` receives failures of the reactive re-runs (collection change / subscription update); the initial run still rejects. */
  function queryWrapper(props: AddDebugTo<AddDisableTo<QueryProps<RecordType>>>, onResponse: (result: QueryResponse<RecordType>) => void, onSameResponse: () => void,
    onError: (error: unknown) => void): Promise<void>;
  function queryWrapper(props?: AddDebugTo<AddDisableTo<QueryProps<RecordType>>>, onResponse?: (result: QueryResponse<RecordType>) => void,
    onSameResponse?: () => void, onError?: (error: unknown) => void): Promise<QueryResponse<RecordType> | void> {
    props = props ?? {};
    if (is.function(onResponse) && is.function(onSameResponse) && is.function(onError)) return wrapper(props, onResponse, onSameResponse, onError);
    if (is.function(onResponse) && is.function(onSameResponse)) return wrapper(props, onResponse, onSameResponse);
    if (is.function(onResponse)) return wrapper(props, onResponse);
    return wrapper(props);
  }

  return queryWrapper;
}

export type Query<RecordType extends Record> = ReturnType<typeof createQuery<RecordType>>;
export type QueryPropsFilters<RecordType extends Record> = QueryProps<RecordType>['filters'];