import type { DataFilters } from '@anupheaus/common';
import { normaliseFilterConditions } from '../../../common/filters';

/** A read request that may carry filters (a query or a distinct, over any record type). */
interface WithFilters {
  filters?: unknown;
}

/**
 * The request with its filters normalised (see `normaliseFilterConditions`: a field with no value means "missing", a
 * broken operand matches nothing) before it reaches the device database or the server. This has to happen here, on
 * the client: JSON leaves an `undefined` value out of the request, so the server would otherwise receive no condition
 * at all and read every record (Vision sc-2518). A request with no filters is returned as it is.
 */
export function withNormalisedFilters<Request extends WithFilters>(request: Request): Request {
  const { filters } = request;
  if (filters == null) return request;
  // Only the values inside the filters change, never their shape, so the request keeps its own filters type.
  return { ...request, filters: normaliseFilterConditions(filters as DataFilters) } as Request;
}
