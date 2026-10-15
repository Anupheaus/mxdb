import type { DataFilters, Record } from '@anupheaus/common';
import { useAuthentication } from '@anupheaus/nexus/server';
import type { MXDBCollection, QueryProps } from '../../common';
import { getCollectionExtensions, type OnQueryPurpose } from './extendCollection';
import type { QueryGate } from './query-gate-models';

/** The signed-in caller's id, or `undefined` when there is none (no auth context: a server-side read, a test). */
function getCallerUserId(): string | undefined {
  try {
    return useAuthentication().user?.id;
  } catch {
    // Outside a socket request there is no auth context to read; the gate then sees an anonymous caller.
    return undefined;
  }
}

/**
 * Binds `collection`'s `onQuery` gate to the current caller. Call it while the request's context is active —
 * at the top of an action, or when a subscription is set up — because the caller is captured now: a
 * subscription's change handler runs from the MongoDB change stream, outside any request, where no caller
 * can be read. `collection` is `undefined` for a name with no registered collection, which has no gate.
 */
export function useQueryGate<RecordType extends Record>(collection: MXDBCollection<RecordType> | undefined): QueryGate<RecordType> {
  const onQuery = collection == null ? undefined : getCollectionExtensions(collection)?.onQuery;
  const userId = getCallerUserId();

  async function askGate(request: QueryProps<RecordType>, purpose: OnQueryPurpose): Promise<QueryProps<RecordType>> {
    if (onQuery == null) return request;
    const gatedRequest = await onQuery({ request, userId, purpose });
    return (gatedRequest ?? request) as QueryProps<RecordType>;
  }

  async function gateRequest(request: QueryProps<RecordType>): Promise<QueryProps<RecordType>> {
    return askGate(request, 'read');
  }

  async function getGateFilters(purpose: OnQueryPurpose = 'read'): Promise<DataFilters<RecordType> | undefined> {
    // An empty request, so the filters that come back are the gate's alone.
    const { filters } = await askGate({}, purpose);
    if (filters == null || Object.keys(filters).length === 0) return undefined;
    return filters;
  }

  return { gateRequest, getGateFilters };
}
