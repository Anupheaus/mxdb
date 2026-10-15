/** The message of the one info entry a C2S sync that wrote logs (also how tests find it). */
export const C2S_SYNC_SUMMARY_MESSAGE = 'C2S sync wrote records';

/** What a C2S sync did to one collection. Counts only: never record values or ids. */
export interface C2SSyncCollectionResult {
  collectionName: string;
  /** Client creates and updates written. */
  upserted: number;
  /** Client deletes written. */
  deleted: number;
  /** Written changes that were merged with a change the client had not seen (see `hasConcurrentServerChange`). */
  conflicts: number;
  /** Changes refused by the read gate or a before-write hook. */
  rejected: number;
  /** Changes whose write failed. */
  failed: number;
}

/** The summary logged once per C2S sync that wrote: totals plus the collections that had any activity. */
export interface C2SSyncSummary extends Omit<C2SSyncCollectionResult, 'collectionName'> {
  /** An array, not an object keyed by collection name, so each collection does not become a new log field. */
  collections: C2SSyncCollectionResult[];
}

type C2SSyncCounts = Omit<C2SSyncCollectionResult, 'collectionName'>;

const COUNT_KEYS: (keyof C2SSyncCounts)[] = ['upserted', 'deleted', 'conflicts', 'rejected', 'failed'];

function addCounts(target: C2SSyncCounts, source: C2SSyncCounts): void {
  for (const key of COUNT_KEYS) target[key] += source[key];
}

function hasActivity(result: C2SSyncCounts): boolean {
  return COUNT_KEYS.some(key => result[key] > 0);
}

/**
 * Builds the C2S write summary from the per-collection results, or `undefined` when nothing was written — a
 * sync with no changes (or only rejected or failed ones, which are already logged individually) logs no info.
 */
export function buildC2SSyncSummary(results: C2SSyncCollectionResult[]): C2SSyncSummary | undefined {
  const byCollection = new Map<string, C2SSyncCollectionResult>();
  for (const result of results) {
    const existing = byCollection.get(result.collectionName);
    if (existing == null) byCollection.set(result.collectionName, { ...result });
    else addCounts(existing, result);
  }
  const collections = [...byCollection.values()].filter(hasActivity);
  const summary: C2SSyncSummary = { upserted: 0, deleted: 0, conflicts: 0, rejected: 0, failed: 0, collections };
  for (const collection of collections) addCounts(summary, collection);
  return summary.upserted + summary.deleted > 0 ? summary : undefined;
}
