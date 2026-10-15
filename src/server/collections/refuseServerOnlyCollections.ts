import { ApiError } from '@anupheaus/common';
import { useLogger } from '@anupheaus/nexus/server';
import { useDb } from '../providers';
import { collectionNamesInClientRequest } from './collectionNamesInClientRequest';
import { isServerOnlyCollection } from './isServerOnlyCollection';

/** What a client is told when its request names a server-only collection. The same for every such request. */
export const CLIENT_REQUEST_REFUSED_MESSAGE = 'This request could not be accepted.';

const FORBIDDEN_STATUS_CODE = 403;

export interface RefuseServerOnlyCollectionsRequest {
  /** The action or subscription the client called, for the log. */
  requestName: string;
  /** The request exactly as the client sent it. */
  request: unknown;
}

/**
 * Refuses a client request that names a server-only collection, before anything is read, written or pushed. A
 * server-only collection holds data only the server may use (stored tokens, sign-in records, webhook markers), and the
 * client hook's own refusal does not stop a client that sends the raw request itself. The whole request is refused,
 * with one answer whatever the collection holds, so nothing about a record in it is revealed; the attempt is logged
 * (the collection, never the request's data). Synchronised, client-only and unregistered collections are left to the
 * request's own handling. Call it in the request's context: the collection is looked up in the caller's database.
 */
export function refuseServerOnlyCollections({ requestName, request }: RefuseServerOnlyCollectionsRequest): void {
  const namedCollections = collectionNamesInClientRequest(request);
  if (namedCollections.length === 0) return;
  const db = useDb();
  const collectionNames = namedCollections.filter(collectionName => isServerOnlyCollection(db.use(collectionName)?.collection));
  if (collectionNames.length === 0) return;
  useLogger().warn('Refused a client request naming a server-only collection', { requestName, collectionNames, securityEvent: 'server-only-collection-refused' });
  throw new ApiError({ message: CLIENT_REQUEST_REFUSED_MESSAGE, statusCode: FORBIDDEN_STATUS_CODE });
}
