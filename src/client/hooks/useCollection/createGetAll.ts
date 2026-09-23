import type { Logger, Record } from '@anupheaus/common';
import type { GetAllRequest } from '../../../common';
import { mxdbGetAllAction, mxdbGetAllSubscription } from '../../../common';
import type { DbCollection } from '../../providers';
import type { UseSubscription } from './createUseSubscription';
import { useSubscriptionWrapper } from './useSubscriptionWrapper';
import type { AddDebugTo, AddDisableTo } from '../../../common/models';
import type { LiveRequestCallbacks } from './live-request-models';
import { toLiveRequestCallbacks } from './toLiveRequestCallbacks';

export function createGetAll<RecordType extends Record>(collection: DbCollection<RecordType>, useSubscription: UseSubscription, logger: Logger) {
  const wrapper = useSubscriptionWrapper<RecordType, object, RecordType[], GetAllRequest, string[]>({
    collection,
    subscription: mxdbGetAllSubscription,
    action: mxdbGetAllAction,
    logger,
    useSubscription,
    onDefaultResponse: () => [],
    onRemoteDefaultResponse: () => [],
    async onExecute() {
      return collection.getAll();
    },
    onRequestTransform: () => ({ collectionName: collection.name }),
  });

  type GetAllProps = AddDebugTo<AddDisableTo<object>>;

  type Callbacks = LiveRequestCallbacks<RecordType[]>;
  type OnResponse = Callbacks['onResponse'];

  /** Reads every record once and resolves with them. */
  function getAllWrapper(props?: GetAllProps): Promise<RecordType[]>;
  /** Reads every record live: `onResponse` receives them now and again whenever they change. */
  function getAllWrapper(props: GetAllProps, onResponse: OnResponse): Promise<void>;
  /** Reads every record live, reporting results (and same-result / re-run-failure notifications) through `callbacks`. */
  function getAllWrapper(props: GetAllProps, callbacks: Callbacks): Promise<void>;
  /** @deprecated Pass `{ onResponse, onSameResponse }` as the second argument instead. */
  function getAllWrapper(props: GetAllProps, onResponse: OnResponse, onSameResponse: () => void): Promise<void>;
  function getAllWrapper(props?: GetAllProps, onResponseOrCallbacks?: OnResponse | Callbacks, onSameResponse?: () => void): Promise<RecordType[] | void> {
    const callbacks = toLiveRequestCallbacks(onResponseOrCallbacks, onSameResponse);
    return callbacks == null ? wrapper(props ?? {}) : wrapper(props ?? {}, callbacks);
  }

  return getAllWrapper;
}

export type GetAll<RecordType extends Record> = ReturnType<typeof createGetAll<RecordType>>;
