import type { NexusSubscription } from '@anupheaus/nexus/common';
import { useSubscription } from '@anupheaus/nexus/client';
import { useBound, useOnUnmount } from '@anupheaus/react-ui';

export type UseSubscription = ReturnType<typeof createUseSubscription>;

export interface UseSubscriptionExecuteProps<Request, Response> {
  disable?: boolean;
  request: Request;
  onUpdate(response: Response, debug?: boolean): void;
  onEmptyUpdate(): Response;
}

export function createUseSubscription() {
  return <Name extends string, Request, Response>(subscription: NexusSubscription<Name, Request, Response>) => {
    const { subscribe: socketAPISubscribe, unsubscribe, onCallback } = useSubscription(subscription as NexusSubscription<Name, Request, Response>);

    useOnUnmount(unsubscribe);

    const subscribe = socketAPISubscribe;

    const execute = useBound(async ({ disable, onUpdate, onEmptyUpdate, request }: UseSubscriptionExecuteProps<Request, Response>): Promise<boolean> => {
      onCallback(onUpdate);
      if (disable) {
        unsubscribe();
        onUpdate(onEmptyUpdate());
      } else {
        await subscribe(request, undefined);
        return true;
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