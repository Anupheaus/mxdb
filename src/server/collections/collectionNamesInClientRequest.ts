import { is } from '@anupheaus/common';

interface NamesACollection {
  collectionName?: unknown;
}

function collectionNameOf(item: unknown): string | undefined {
  if (!is.plainObject(item)) return undefined;
  const { collectionName } = item as NamesACollection;
  return is.string(collectionName) ? collectionName : undefined;
}

/**
 * The collections a client request names. Every mxdb request is one of two shapes: one collection
 * (`{ collectionName, … }` — get, getAll, query, distinct and their subscriptions) or a list of them
 * (`[{ collectionName, … }]` — sync and reconcile). Reading both shapes here means a new request of either shape is
 * covered without naming it. Anything that names no collection gives none.
 */
export function collectionNamesInClientRequest(request: unknown): string[] {
  const items: unknown[] = Array.isArray(request) ? request : [request];
  return items.map(collectionNameOf).removeNull().distinct();
}
