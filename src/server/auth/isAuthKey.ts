/**
 * Whether a value can be used as a key in an auth lookup: a non-empty string, and nothing else.
 *
 * Auth keys (request ids, session and registration tokens, key hashes, user and device ids) arrive from REST bodies and
 * socket handshakes, which carry parsed JSON. An object such as `{ "$ne": null }` placed in a MongoDB filter is an
 * OPERATOR, not a value: `{ keyHash: { $ne: null } }` matches the first registered device, and would sign whoever sent it
 * in as that device. So every auth lookup refuses a key that is not a non-empty string before it reaches a filter
 * (Vision sc-620).
 */
export function isAuthKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
