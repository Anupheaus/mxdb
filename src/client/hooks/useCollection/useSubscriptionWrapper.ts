import { is, type AnyObject, type Logger, type PromiseMaybe, type Record } from '@anupheaus/common';
import type { DbCollection } from '../../providers';
import { useAction, useNexus } from '@anupheaus/nexus/client';
import type { UseSubscription } from './createUseSubscription';
import type { NexusAction, NexusSubscription } from '@anupheaus/nexus/common';
import { useLayoutEffect, useRef } from 'react';
import { DateTime } from 'luxon';
import type { AddDisableTo } from '../../../common/models';
import { ACTION_TIMEOUT_MS, withTimeout } from '../../utils/actionTimeout';

const RequestCancelled = Symbol('RequestCancelled');

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

  // listen to changes from the client collection and invoke again when it changes
  useLayoutEffect(() => collection.onChange(() => executeValidateAndUpdateRef.current()), []);

  async function invoke(props: AddDisableTo<Request>, onResponse: (result: Response) => void, onSameResponse: () => void): Promise<void>;
  async function invoke(props: AddDisableTo<Request>, onResponse: (result: Response) => void): Promise<void>;
  async function invoke(props: AddDisableTo<Request>): Promise<Response>;
  async function invoke(props: AddDisableTo<Request>, onResponse?: (result: Response) => void, onSameResponse?: () => void): Promise<void | Response> {
    const { disable, ...rest } = props;
    const request = rest as Request;
    const isActionRequired = !is.function(onResponse);

    const execute = async () => {
      logger.silly('Executing query locally', { disable, request });
      if (disable) {
        logger.silly('Query is disabled, returning default', { disable, request });
        return onDefaultResponse();
      }
      const requestId = lastRequestIdRef.current = Math.uniqueId();
      logger.debug(`[${requestId}] Querying records for collection "${collection.name}"...`, props);
      const startTime = DateTime.now();
      const response = await onExecute(request);
      if (lastRequestIdRef.current !== requestId) return RequestCancelled;
      const timeTaken = DateTime.now().diff(startTime).milliseconds;
      if (disable) return onDefaultResponse();
      if (slowThreshold != null && timeTaken > slowThreshold) {
        logger.warn(`[${requestId}] Query on collection "${collection.name}" took ${timeTaken}ms`, props);
      } else {
        logger.debug(`[${requestId}] Query on collection "${collection.name}" completed (time taken: ${timeTaken}ms).`);
      }
      logger.silly('Finished executing query locally', { disable, request, response });
      return response;
    };

    const okToExecute = () => {
      if (disable || onResponse == null) return false;
      if (!getIsConnected() && onOfflineAction != null) onOfflineAction(); // if we are offline
      return true;
    };

    // execute and validate and update the result only if it has changed
    const executeValidateAndUpdate = executeValidateAndUpdateRef.current = async () => {
      if (!okToExecute()) return;
      const result = await execute();
      if (result === RequestCancelled) {
        logger.silly('Request cancelled, so not validating and updating', { disable, request });
        return;
      }
      validateAndUpdate(result);
    };

    // validate and update the result only if it has changed
    const validateAndUpdate = (response: Response) => {
      if (!okToExecute()) return;
      const resultHash = Object.hash(response);
      if (lastResultHashRef.current === resultHash) {
        logger.silly('Result has not changed, so calling onSameResponse', { disable, request });
        onSameResponse?.();
        return;
      }
      logger.silly('Result has changed, so calling onResponse', { disable, request });
      lastResultHashRef.current = resultHash;
      onResponse?.(response);
    };

    logger.silly('Invoking remote query', { disable, isActionRequired, request });
    remoteQueryCalledRef.current = await withTimeout(
      remoteInvoke({
        request: (onRequestTransform?.(request) ?? request) as RemoteRequest,
        disable: disable || isActionRequired,
        onEmptyUpdate: onRemoteDefaultResponse,
        onUpdate: async response => {
          logger.silly('Received remote query response', { disable, isActionRequired, request, response });
          await onRemoteResponse?.(response);
          await executeValidateAndUpdate();
          remoteQueryCalledRef.current = false;
        },
      }),
      ACTION_TIMEOUT_MS,
      `${subscription.name}(subscription:${collection.name})`,
    );

    if (isActionRequired) {
      logger.silly('Invoking action', { disable, isActionRequired, request });
      const result = await withTimeout(
        actionResult[action.name]!((onRequestTransform?.(request) ?? request) as RemoteRequest),
        ACTION_TIMEOUT_MS,
        `${action.name}(${collection.name})`,
      );
      logger.silly('Received action response', { disable, isActionRequired, request, result });
      await onRemoteResponse?.(result);
    }

    let result = await execute();
    logger.silly('Finished calling local execute', { disable, isActionRequired, request, result, remoteQueryCalled: remoteQueryCalledRef.current });
    if (result === RequestCancelled) result = onDefaultResponse();
    if (!remoteQueryCalledRef.current) {
      logger.silly('Validating and updating result after local execution', { disable, isActionRequired, request, result });
      validateAndUpdate(result);
    }

    return result;
  }

  return invoke;
}