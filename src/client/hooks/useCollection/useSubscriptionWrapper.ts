import { debounce, is, type AnyObject, type Logger, type PromiseMaybe, type Record } from '@anupheaus/common';
import type { DbCollection } from '../../providers';
import { useAction, useNexus } from '@anupheaus/nexus/client';
import type { UseSubscription } from './createUseSubscription';
import type { NexusAction, NexusSubscription } from '@anupheaus/nexus/common';
import { useLayoutEffect, useRef } from 'react';
import { DateTime } from 'luxon';
import type { AddDisableTo } from '../../../common/models';
import { ACTION_TIMEOUT_MS, withTimeout } from '../../utils/actionTimeout';

const RequestCancelled = Symbol('RequestCancelled');

/** Collection mutations arrive in bursts (initial sync/hydration writes many records); coalesce a burst into a
 *  single query re-execution rather than re-running the query per change. Each subscription debounces its OWN
 *  onChange callback (its own `debounce` instance), so distinct subscribers still each re-run — only repeated
 *  changes for the same subscriber within this window are collapsed. */
const COLLECTION_CHANGE_DEBOUNCE_MS = 50;

interface Props<RecordType extends Record, Request extends AnyObject, Response extends AnyObject, RemoteRequest extends AnyObject, RemoteResponse> {
  collection: DbCollection<RecordType>;
  logger: Logger;
  subscription: NexusSubscription<string, RemoteRequest, RemoteResponse>;
  action: NexusAction<string, RemoteRequest, RemoteResponse>;
  slowThreshold?: number;
  useSubscription: UseSubscription;
  onDefaultResponse(): Response;
  onRemoteDefaultResponse(): RemoteResponse;
  onRemoteResponse?(response: RemoteResponse): PromiseMaybe<void>;
  onOfflineAction?(): void;
  onExecute(request: Request): Promise<Response>;
  onRequestTransform?(request: Request): RemoteRequest;
}

export function useSubscriptionWrapper<RecordType extends Record, Request extends AnyObject, Response extends AnyObject, RemoteRequest extends AnyObject, RemoteResponse>({
  collection,
  logger,
  subscription,
  action,
  slowThreshold,
  useSubscription,
  onDefaultResponse,
  onOfflineAction,
  onRemoteDefaultResponse,
  onRemoteResponse,
  onRequestTransform,
  onExecute,
}: Props<RecordType, Request, Response, RemoteRequest, RemoteResponse>) {
  const { getIsConnected } = useNexus();
  const { execute: remoteInvoke } = useSubscription(subscription);
  const actionResult = useAction(action);
  const lastRequestIdRef = useRef<string>();
  const lastResultHashRef = useRef<string>();
  const executeValidateAndUpdateRef = useRef(() => Promise.resolve());
  const remoteQueryCalledRef = useRef(false);

  // Re-run the query when the client collection changes, debounced (via @anupheaus/common's `debounce`) so a burst
  // of changes collapses into one re-execution instead of one per change. Cleanup cancels any pending re-run and
  // unsubscribes, so nothing re-executes after unmount.
  useLayoutEffect(() => {
    const onCollectionChange = debounce(() => executeValidateAndUpdateRef.current(), COLLECTION_CHANGE_DEBOUNCE_MS);
    const unsubscribe = collection.onChange(onCollectionChange);
    return () => {
      onCollectionChange.cancel();
      unsubscribe();
    };
  }, []);

  // `onError` receives failures of the reactive RE-RUNS (triggered by a collection change or a subscription update),
  // which nothing awaits. A failure of the initial run still rejects the returned promise.
  async function invoke(props: AddDisableTo<Request>, onResponse: (result: Response) => void, onSameResponse: (() => void) | undefined,
    onError: (error: unknown) => void): Promise<void>;
  async function invoke(props: AddDisableTo<Request>, onResponse: (result: Response) => void, onSameResponse: () => void): Promise<void>;
  async function invoke(props: AddDisableTo<Request>, onResponse: (result: Response) => void): Promise<void>;
  async function invoke(props: AddDisableTo<Request>): Promise<Response>;
  async function invoke(props: AddDisableTo<Request>, onResponse?: (result: Response) => void, onSameResponse?: () => void,
    onError?: (error: unknown) => void): Promise<void | Response> {
    const { disable, ...rest } = props;
    const request = rest as Request;
    const isActionRequired = !is.function(onResponse);

    const execute = async () => {
      if (disable) {
        return onDefaultResponse();
      }
      const requestId = lastRequestIdRef.current = Math.uniqueId();
      const startTime = DateTime.now();
      const response = await onExecute(request);
      if (lastRequestIdRef.current !== requestId) return RequestCancelled;
      const timeTaken = DateTime.now().diff(startTime).milliseconds;
      if (disable) return onDefaultResponse();
      if (slowThreshold != null && timeTaken > slowThreshold) {
        logger.warn(`[${requestId}] Query on collection "${collection.name}" took ${timeTaken}ms`, props);
      }
      return response;
    };

    const okToExecute = () => {
      if (disable || onResponse == null) return false;
      if (!getIsConnected() && onOfflineAction != null) onOfflineAction(); // if we are offline
      return true;
    };

    // Re-runs are fire-and-forget (debounced collection changes; subscription callbacks the socket layer doesn't
    // await), so a failure must be reported here or it becomes an unhandled rejection and the consumer keeps
    // showing its last result as if nothing went wrong.
    const reportRerunError = (error: unknown) => {
      // The consumer now shows an error rather than the last result, so the next successful result must be
      // delivered through onResponse (clearing the error) even when it is identical to the one before the failure.
      lastResultHashRef.current = undefined;
      if (onError != null) {
        onError(error);
        return;
      }
      logger.error(`Re-running the request on collection "${collection.name}" failed`, { error: error instanceof Error ? error.message : String(error) });
    };

    // execute and validate and update the result only if it has changed
    const executeValidateAndUpdate = executeValidateAndUpdateRef.current = async () => {
      try {
        if (!okToExecute()) return;
        const result = await execute();
        if (result === RequestCancelled) {
          return;
        }
        validateAndUpdate(result);
      } catch (error) {
        reportRerunError(error);
      }
    };

    // validate and update the result only if it has changed
    const validateAndUpdate = (response: Response) => {
      if (!okToExecute()) return;
      const resultHash = Object.hash(response);
      if (lastResultHashRef.current === resultHash) {
        onSameResponse?.();
        return;
      }
      lastResultHashRef.current = resultHash;
      onResponse?.(response);
    };

    remoteQueryCalledRef.current = await withTimeout(
      remoteInvoke({
        request: (onRequestTransform?.(request) ?? request) as RemoteRequest,
        disable: disable || isActionRequired,
        onEmptyUpdate: onRemoteDefaultResponse,
        onUpdate: async response => {
          try {
            await onRemoteResponse?.(response);
            await executeValidateAndUpdate();
          } catch (error) {
            reportRerunError(error);
          }
          remoteQueryCalledRef.current = false;
        },
      }),
      ACTION_TIMEOUT_MS,
      `${subscription.name}(subscription:${collection.name})`,
    );

    if (isActionRequired) {
      const result = await withTimeout(
        actionResult[action.name]!((onRequestTransform?.(request) ?? request) as RemoteRequest),
        ACTION_TIMEOUT_MS,
        `${action.name}(${collection.name})`,
      );
      await onRemoteResponse?.(result);
    }

    let result = await execute();
    if (result === RequestCancelled) result = onDefaultResponse();
    if (!remoteQueryCalledRef.current) {
      validateAndUpdate(result);
    }

    return result;
  }

  return invoke;
}
