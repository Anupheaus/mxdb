import type { NexusSubscription } from '@anupheaus/nexus/common';
import { useSubscription } from '@anupheaus/nexus/client';
import { useBound, useOnUnmount } from '@anupheaus/react-ui';
import type { Logger } from '@anupheaus/common';

export type UseSubscription = ReturnType<typeof createUseSubscription>;

export interface UseSubscriptionExecuteProps<Request, Response> {
  disable?: boolean;
  request: Request;
  onUpdate(response: Response, debug?: boolean): void;
  onEmptyUpdate(): Response;
}

export function createUseSubscription(logger?: Logger) {
  return <Name extends string, Request, Response>(subscription: NexusSubscription<Name, Request, Response>) => {
    const { subscribe: socketAPISubscribe, unsubscribe, onCallback } = useSubscription(subscription as NexusSubscription<Name, Request, Response>);

    useOnUnmount(unsubscribe);

    const subscribe = socketAPISubscribe;

    const execute = useBound(async ({ disable, onUpdate, onEmptyUpdate, request }: UseSubscriptionExecuteProps<Request, Response>): Promise<boolean> => {
      logger?.silly('Registering callback', { disable, request, onUpdate });
      onCallback(onUpdate);
      if (disable) {
        logger?.silly('Disabled, so unsubscribing', { disable, request });
        unsubscribe();
        logger?.silly('Calling onUpdate with empty response', { disable, request });
        onUpdate(onEmptyUpdate());
      } else {

        // if (getIsConnected()) {
        logger?.silly('Subscribing to server', { disable, request });
        await subscribe(request, undefined);
        return true;
        // } else {
        //   logger?.silly('Offline, so calling onUpdate with empty response', { disable, request });
        //   onUpdate(onEmptyUpdate());
        // }
      }
      return false;
    });

    return {
      execute,
      unsubscribe,
      subscribe,
      onCallback,
    };
  };

}