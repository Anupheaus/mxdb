import type { Record } from '@anupheaus/common';
import type { DbCollection } from '../../providers';

/**
 * Server gets in flight, per collection instance and record id. Keyed on the `DbCollection` instance (one per
 * collection per open database) rather than the collection name, so two databases open side by side never share
 * a request. A WeakMap so a closed database's entries go with it.
 */
const inFlightByCollection = new WeakMap<DbCollection<Record>, Map<string, Promise<void>>>();

function inFlightFor(dbCollection: DbCollection<Record>): Map<string, Promise<void>> {
  let inFlight = inFlightByCollection.get(dbCollection);
  if (inFlight == null) {
    inFlight = new Map();
    inFlightByCollection.set(dbCollection, inFlight);
  }
  return inFlight;
}

export interface FetchSharingInFlightProps<RecordType extends Record> {
  dbCollection: DbCollection<RecordType>;
  /** The ids to bring into the local store — may repeat, and may include ids another get is already fetching. */
  ids: string[];
  /** Asks the server for these ids; resolves once the records it found are in the local store. */
  fetch(ids: string[]): Promise<unknown>;
}

/**
 * Brings `ids` into the local store from the server, joining any request already fetching one of them instead of
 * asking again. Several components commonly ask for the same record as they mount together, and each has its own
 * `get`, so without this every one of them would send the server the same request.
 *
 * Only in-flight requests are shared, never their answers: once a request settles its ids are released, so a later
 * get asks the server afresh. A failed request fails every get waiting on it, and is released like any other, so
 * the next get retries rather than inheriting the failure.
 */
export async function fetchSharingInFlight<RecordType extends Record>({ dbCollection, ids, fetch }: FetchSharingInFlightProps<RecordType>): Promise<void> {
  const inFlight = inFlightFor(dbCollection as unknown as DbCollection<Record>);
  const distinctIds = Array.from(new Set(ids));
  const requests = new Set(distinctIds.map(id => inFlight.get(id)).removeNull());
  const idsToFetch = distinctIds.filter(id => !inFlight.has(id));

  if (idsToFetch.length > 0) {
    const request = fetch(idsToFetch).then(() => undefined);
    idsToFetch.forEach(id => inFlight.set(id, request));
    // Registered before anyone awaits the request, so the ids are released before any waiter resumes — a get
    // made straight after a failure must not find, and join, the failed request.
    const release = () => idsToFetch.forEach(id => { if (inFlight.get(id) === request) inFlight.delete(id); });
    request.then(release, release);
    requests.add(request);
  }

  await Promise.all(requests);
}
