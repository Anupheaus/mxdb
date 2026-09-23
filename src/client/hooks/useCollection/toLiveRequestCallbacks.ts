import { is } from '@anupheaus/common';
import type { LiveRequestCallbacks } from './live-request-models';

/**
 * Normalises the ways a live request's callbacks can be passed — a callbacks object, a bare
 * `onResponse` function, or the deprecated positional `(onResponse, onSameResponse)` pair — into a
 * single callbacks object. Returns `undefined` when no `onResponse` was given (a one-off request).
 */
export function toLiveRequestCallbacks<Response>(
  onResponseOrCallbacks: LiveRequestCallbacks<Response>['onResponse'] | LiveRequestCallbacks<Response> | undefined,
  onSameResponse?: () => void,
): LiveRequestCallbacks<Response> | undefined {
  if (is.function(onResponseOrCallbacks)) return { onResponse: onResponseOrCallbacks, onSameResponse };
  if (onResponseOrCallbacks != null && is.function(onResponseOrCallbacks.onResponse)) return onResponseOrCallbacks;
  return undefined;
}
