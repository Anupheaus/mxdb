import type { Logger } from '@anupheaus/common';
import { is, type Record } from '@anupheaus/common';
import type { DistinctProps, DistinctRequest, DistinctResults } from '../../../common';
import { mxdbDistinctAction, mxdbDistinctSubscription } from '../../../common';
import type { DbCollection } from '../../providers';
import type { UseSubscription } from './createUseSubscription';
import { useSubscriptionWrapper } from './useSubscriptionWrapper';
import type { AddDisableTo } from '../../../common/models';
import type { LiveRequestCallbacks } from './live-request-models';
import { toLiveRequestCallbacks } from './toLiveRequestCallbacks';

export function createDistinct<RecordType extends Record>(collection: DbCollection<RecordType>, useSubscription: UseSubscription, logger: Logger) {
  const distinct = useSubscriptionWrapper<RecordType, DistinctProps<RecordType>, DistinctResults<RecordType>, DistinctRequest, string>({
    collection,
    subscription: mxdbDistinctSubscription,
    action: mxdbDistinctAction,
    logger,
    slowThreshold: 1500,
    onDefaultResponse: () => [],
    onRemoteDefaultResponse: () => '',
    onExecute: request => collection.distinct(request),
    onRequestTransform: request => ({ ...request as DistinctRequest, collectionName: collection.name }),
    useSubscription,
  });

  type Props<Key extends keyof RecordType> = AddDisableTo<DistinctProps<RecordType, Key>>;
  type Callbacks<Key extends keyof RecordType> = LiveRequestCallbacks<DistinctResults<RecordType, Key>>;
  type OnResponse<Key extends keyof RecordType> = Callbacks<Key>['onResponse'];

  /** Reads the distinct values of `field` once. */
  function distinctWrapper<Key extends keyof RecordType>(field: Key, disable?: boolean): Promise<DistinctResults<RecordType, Key>>;
  /** Reads the distinct values once. */
  function distinctWrapper<Key extends keyof RecordType>(props: Props<Key>): Promise<DistinctResults<RecordType, Key>>;
  /** Reads the distinct values live: `onResponse` receives them now and again whenever they change. */
  function distinctWrapper<Key extends keyof RecordType>(props: Props<Key>, onResponse: OnResponse<Key>): Promise<void>;
  /** Reads the distinct values live, reporting results (and re-run failures) through `callbacks`. */
  function distinctWrapper<Key extends keyof RecordType>(props: Props<Key>, callbacks: Callbacks<Key>): Promise<void>;
  /** @deprecated Pass `{ field, disable }` as the first argument and `onResponse` (or `{ onResponse }`) as the second instead. */
  function distinctWrapper<Key extends keyof RecordType>(field: Key, onResponse: OnResponse<Key>, disable?: boolean): Promise<void>;
  function distinctWrapper<Key extends keyof RecordType>(fieldOrProps: Key | Props<Key>,
    disableOrCallbacks?: boolean | OnResponse<Key> | Callbacks<Key>, deprecatedDisable?: boolean) {
    const props = (is.string(fieldOrProps) ? { field: fieldOrProps as Key } : fieldOrProps) as Props<Key>;
    const disable = is.boolean(disableOrCallbacks) ? disableOrCallbacks : deprecatedDisable ?? props.disable;
    const callbacks = is.boolean(disableOrCallbacks) ? undefined : toLiveRequestCallbacks(disableOrCallbacks);
    const request = { ...props, disable };
    return callbacks == null ? distinct(request) : distinct(request, callbacks as LiveRequestCallbacks<DistinctResults<RecordType>>);
  }

  return distinctWrapper;
}

export type Distinct<RecordType extends Record> = ReturnType<typeof createDistinct<RecordType>>;
