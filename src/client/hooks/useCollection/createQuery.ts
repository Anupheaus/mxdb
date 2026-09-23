import type { Logger, Record } from '@anupheaus/common';
import type { QueryProps, QueryRequest } from '../../../common';
import { mxdbQueryAction, mxdbQuerySubscription } from '../../../common';
import { useRef } from 'react';
import type { UseSubscription } from './createUseSubscription';
import type { DbCollection } from '../../providers';
import { useSubscriptionWrapper } from './useSubscriptionWrapper';
import type { AddDebugTo, AddDisableTo } from '../../../common/models';
import type { LiveRequestCallbacks } from './live-request-models';
import { toLiveRequestCallbacks } from './toLiveRequestCallbacks';

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

  type Props = AddDebugTo<AddDisableTo<QueryProps<RecordType>>>;
  type Callbacks = LiveRequestCallbacks<QueryResponse<RecordType>>;
  type OnResponse = Callbacks['onResponse'];

  /** Runs the query once and resolves with the result. */
  function queryWrapper(props?: Props): Promise<QueryResponse<RecordType>>;
  /** Runs the query live: `onResponse` receives the result now and again whenever it changes. */
  function queryWrapper(props: Props, onResponse: OnResponse): Promise<void>;
  /** Runs the query live, reporting results (and same-result / re-run-failure notifications) through `callbacks`. */
  function queryWrapper(props: Props, callbacks: Callbacks): Promise<void>;
  /** @deprecated Pass `{ onResponse, onSameResponse }` as the second argument instead. */
  function queryWrapper(props: Props, onResponse: OnResponse, onSameResponse: () => void): Promise<void>;
  function queryWrapper(props?: Props, onResponseOrCallbacks?: OnResponse | Callbacks, onSameResponse?: () => void): Promise<QueryResponse<RecordType> | void> {
    const callbacks = toLiveRequestCallbacks(onResponseOrCallbacks, onSameResponse);
    return callbacks == null ? wrapper(props ?? {}) : wrapper(props ?? {}, callbacks);
  }

  return queryWrapper;
}

export type Query<RecordType extends Record> = ReturnType<typeof createQuery<RecordType>>;
export type QueryPropsFilters<RecordType extends Record> = QueryProps<RecordType>['filters'];