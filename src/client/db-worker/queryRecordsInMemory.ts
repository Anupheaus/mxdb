import { DateTime } from 'luxon';
import { DataSorts } from '@anupheaus/common';
import type { DataFilters, DataRequest, Record as EntityRecord } from '@anupheaus/common';
import type { DistinctProps, DistinctResults, QueryResults } from '../../common';
import { createFilterMatcher, normaliseFilterConditions } from '../../common/filters';

/** Reduce a value to something orderable, matching how the SQL path orders json_extract results. */
function toComparable(value: unknown): number | string | boolean | null {
  if (value == null) return null;
  if (DateTime.isDateTime(value)) return value.valueOf();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  return String(value);
}

function compareValues(a: unknown, b: unknown): number {
  const aValue = toComparable(a);
  const bValue = toComparable(b);
  if (aValue == null && bValue == null) return 0;
  if (aValue == null) return -1; // NULLs sort first in ascending order, matching SQLite
  if (bValue == null) return 1;
  return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
}

function applySorts<T extends EntityRecord>(records: T[], sorts: DataRequest<T>['sorts']): T[] {
  const strictSorts = DataSorts.toArray(sorts);
  if (strictSorts.length === 0) return records;
  return [...records].sort((first, second) => {
    for (const [field, direction] of strictSorts) {
      const comparison = compareValues(first[field], second[field]);
      if (comparison !== 0) return direction === 'desc' ? -comparison : comparison;
    }
    return 0;
  });
}

/**
 * The records meeting `filters` (original objects, not copies). This is the device's only filter evaluation: the
 * filters are made canonical once (`normaliseFilterConditions`) and compiled once (`createFilterMatcher`, which
 * reads them exactly as MongoDB does on the server), then run per record.
 */
export function filterRecordsInMemory<T extends EntityRecord>(records: T[], filters: DataFilters<T> | undefined): T[] {
  const matches = createFilterMatcher(normaliseFilterConditions(filters));
  return records.filter(matches);
}

/** Filter/sort/paginate records entirely in memory, with no worker round-trip. */
export function queryRecordsInMemory<T extends EntityRecord>(records: T[], { filters, sorts, pagination }: DataRequest<T>): QueryResults<T> {
  const matched = filterRecordsInMemory(records, filters);

  const sorted = applySorts(matched, sorts);
  const total = sorted.length;
  const offset = pagination?.offset ?? 0;
  const paged = pagination ? sorted.slice(offset, offset + pagination.limit) : sorted;
  return { records: paged, total };
}

/** Distinct values of a scalar field over records that already meet the filters, entirely in memory. Returns null
 *  (the worker then reads the values for those same records) when any value is non-scalar (dates/objects/arrays —
 *  whose SQL json_extract representation differs from the in-memory value), or when sorted by anything other than
 *  the distinct field itself. */
export function distinctRecordsInMemory<T extends EntityRecord, Key extends keyof T>(
  matched: T[],
  { field, sorts }: Omit<DistinctProps<T, Key>, 'filters'>,
): DistinctResults<T, Key> | null {
  const values: T[Key][] = [];
  const seen = new Set<T[Key]>();
  for (const record of matched) {
    const raw = record[field];
    // A missing field reads as SQL NULL, same as an explicit null — collapse both so they dedupe to one value.
    const value = (raw === undefined ? null : raw) as T[Key];
    if (value != null && (value instanceof Date || DateTime.isDateTime(value) || typeof value === 'object')) return null;
    if (!seen.has(value)) { seen.add(value); values.push(value); }
  }

  const strictSorts = DataSorts.toArray(sorts);
  if (strictSorts.length === 0) return values;
  // In memory a distinct list can only be ordered by the distinct field itself (its own values); anything else
  // is what the worker's ORDER BY handles — defer to it.
  if (strictSorts.length > 1 || strictSorts[0]![0] !== field) return null;
  const sorted = [...values].sort(compareValues);
  return strictSorts[0]![1] === 'desc' ? sorted.reverse() : sorted;
}
