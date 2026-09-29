import { ArgumentInvalidError, is } from '@anupheaus/common';
import type { ClientDispatcherRequest } from '../../common/sync-engine';

/**
 * Refuses a C2S sync request whose shape is not what a client sends, before any of it is touched. Every record
 * id becomes a key in the socket's dispatcher filter and a value in a MongoDB `$in`, so an id that is not a
 * plain string — e.g. an operator object such as `{ "$gt": "" }` — could match other records or make the
 * database reject the query part-way through a sync.
 */
export function assertValidSyncRequest(request: unknown): asserts request is ClientDispatcherRequest {
  if (!Array.isArray(request)) throw new ArgumentInvalidError('request', request);
  for (const item of request as unknown[]) {
    const { collectionName, records } = (item ?? {}) as { collectionName?: unknown; records?: unknown };
    if (!is.string(collectionName) || collectionName.length === 0) throw new ArgumentInvalidError('collectionName', collectionName);
    if (!Array.isArray(records)) throw new ArgumentInvalidError('records', { collectionName });
    for (const record of records as unknown[]) {
      const { id, hash, entries } = (record ?? {}) as { id?: unknown; hash?: unknown; entries?: unknown };
      if (!is.string(id) || id.length === 0) throw new ArgumentInvalidError('recordId', { collectionName, id });
      if (hash != null && !is.string(hash)) throw new ArgumentInvalidError('hash', { collectionName, id });
      if (!Array.isArray(entries)) throw new ArgumentInvalidError('entries', { collectionName, id });
    }
  }
}
