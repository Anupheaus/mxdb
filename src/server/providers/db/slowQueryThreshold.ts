/** Default for the slow-query warning, in ms. */
const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 3_000;

/** Environment variable that overrides the slow-query warning threshold, in ms. */
export const SLOW_QUERY_THRESHOLD_ENV = 'MXDB_SLOW_QUERY_MS';

/**
 * How long a query may take before it is logged as slow. Read on each call so it can be changed without a
 * restart of the module; a missing, non-numeric or non-positive value falls back to the default.
 */
export function getSlowQueryThresholdMs(): number {
  const configured = Number(process.env[SLOW_QUERY_THRESHOLD_ENV]);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SLOW_QUERY_THRESHOLD_MS;
}
