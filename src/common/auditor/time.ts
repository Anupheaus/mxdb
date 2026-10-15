import { decodeTime, monotonicFactory, ulid } from 'ulidx';

let clockDriftMs = 0;
let monoUlid = monotonicFactory();

/** Update the client-server clock drift. Call this when a new auth token (ULID) arrives from server. */
export function setClockDrift(drift: number) {
  clockDriftMs = drift;
  monoUlid = monotonicFactory();
}

export function generateUlid(): string {
  return monoUlid(Date.now() - clockDriftMs);
}


/**
 * A ULID that sorts before every entry any device could have written (its timestamp is the epoch), for the Created entry
 * that anchors a record which had no audit when it was first edited: the stored record is the state every later entry builds on.
 */
export function generateAnchorUlid(): string {
  return ulid(0);
}

/**
 * A new ULID that is guaranteed to sort after `latestId` (typically the latest entry of an audit the
 * caller is appending to). Normally that is just {@link generateUlid}; but when `latestId` came from a
 * device whose clock runs ahead, a wall-clock ULID would sort BEFORE it and replay would apply the new
 * entry too early — so the id is then minted one millisecond after `latestId`'s own timestamp instead.
 */
export function generateUlidAfter(latestId: string | undefined): string {
  const candidate = generateUlid();
  if (latestId == null || candidate > latestId) return candidate;
  return ulid(decodeTime(latestId) + 1);
}
