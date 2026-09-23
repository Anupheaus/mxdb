import type { NexusSubscription } from '@anupheaus/nexus/common';
import { createServerSubscription, useLogger } from '@anupheaus/nexus/server';
import { InternalError, type PromiseMaybe } from '@anupheaus/common';
import { useClient } from '../hooks';
import { clearSubscriptionDataKeys } from '../subscriptionDataStore';
import { isSocketDisconnectError } from '../utils/isSocketDisconnectError';

interface SocketSubscriptionBaseParams<Request, Response> {
  request: Request;
  subscriptionId: string;
  /**
   * Pushes a new response to the client and remembers it as the previous response. The returned
   * promise resolves once the push has been sent and never rejects — a failed push (e.g. the client
   * has already disconnected) is logged here, so fire-and-forget callers cannot leak a rejection.
   */
  update(response: Response): Promise<void>;
  onUnsubscribe(handler: () => void): void;
}

interface MXDBSyncServerSubscriptionHandlerParameters<Request, Response, AdditionalData = unknown> extends SocketSubscriptionBaseParams<Request, Response> {
  previousResponse: Response | undefined;
  additionalData: AdditionalData | undefined;
  updateAdditionalData(data: AdditionalData): void;
}

type MXDBSyncServerSubscriptionHandler<Request, Response, AdditionalData = unknown> =
  (parameters: MXDBSyncServerSubscriptionHandlerParameters<Request, Response, AdditionalData>) => PromiseMaybe<Response>;

/** Rejection reasons are not guaranteed to be `Error`s — use a `message` when present, else the value itself. */
function toErrorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : String(error);
}

export function createServerCollectionSubscription<AdditionalData = unknown>() {
  return <Name extends string, Request, Response>(subscription: NexusSubscription<Name, Request, Response>,
    handler: MXDBSyncServerSubscriptionHandler<Request, Response, AdditionalData>) => {
    return createServerSubscription(subscription as NexusSubscription<Name, Request, Response>,
      async ({ request, subscriptionId, update, onUnsubscribe }) => {
        // Captured while the socket's async context is active: updates are usually pushed later from
        // change-stream callbacks, which run outside that context.
        const logger = useLogger();
        const { isDataAvailable, getData, setData } = useClient();
        const saveAsPreviousResponse = (response: Response) => setData(`subscription-data.${subscriptionId}`, response);
        const updateAdditionalData = (data: AdditionalData) => setData(`subscription-data.additional.${subscriptionId}`, data);
        const additionalData = getData<AdditionalData>(`subscription-data.additional.${subscriptionId}`);
        if (!isDataAvailable()) throw new InternalError('Unable to retrieve the data for a subscription request this client, is not available at this location.');
        const previousResponse = getData<Response | undefined>(`subscription-data.${subscriptionId}`);
        const wrappedUpdate = async (response: Response): Promise<void> => {
          saveAsPreviousResponse(response);
          try {
            await update(response);
          } catch (error) {
            const meta = { subscriptionId, error: toErrorMessage(error) };
            if (isSocketDisconnectError(error)) {
              logger.debug('Subscription update not sent (socket disconnected — expected when the client has left)', meta);
            } else {
              logger.error('Subscription update failed to send', meta);
            }
          }
        };
        const wrappedOnUnsubscribe = (fn: () => void) => {
          onUnsubscribe(() => {
            clearSubscriptionDataKeys(subscriptionId);
            fn();
          });
        };
        const result = await handler({
          previousResponse, request, subscriptionId,
          additionalData, updateAdditionalData, update: wrappedUpdate, onUnsubscribe: wrappedOnUnsubscribe,
        });
        saveAsPreviousResponse(result);
        return result;
      });
  };
}
