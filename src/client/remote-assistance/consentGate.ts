import type { RemoteSqlMutatingRequestInfo } from './models';

/**
 * Creates an in-memory, ask-once consent gate for mutating remote SQL.
 *
 * The first invocation determines the decision (defaults to `false` if no callback is provided).
 * Subsequent invocations return the memoized decision without re-calling the callback.
 */
export function createMutatingConsentGate(
  onRequest: ((info: RemoteSqlMutatingRequestInfo) => Promise<boolean>) | undefined,
): (info: RemoteSqlMutatingRequestInfo) => Promise<boolean> {
  let hasDecision = false;
  let decision = false;

  return async (info: RemoteSqlMutatingRequestInfo) => {
    if (hasDecision) return decision;
    hasDecision = true;
    decision = onRequest == null ? false : await onRequest(info);
    return decision;
  };
}

