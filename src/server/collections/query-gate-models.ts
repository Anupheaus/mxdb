import type { DataFilters, Record } from '@anupheaus/common';
import type { QueryProps } from '../../common';
import type { OnQueryPurpose } from './extendCollection';

/**
 * A collection's read gate — its `onQuery` hook — bound to the caller who is reading. Every server path a
 * client can read a collection through goes through one of these operations, so the gate cannot be bypassed
 * by choosing a different read (`get`, `getAll`, `distinct`) instead of `query`.
 */
export interface QueryGate<RecordType extends Record = Record> {
  /**
   * The request to fetch with: the client's `request` as the gate rewrote it (scoped filters, interpreted
   * `serverHints`), or `request` unchanged when the collection has no gate or the gate returns nothing.
   */
  gateRequest(request: QueryProps<RecordType>): Promise<QueryProps<RecordType>>;
  /**
   * The filters the gate narrows a read of the whole collection to, for reads that are not a query (`get`,
   * `getAll`). `undefined` when nothing narrows it — no gate, or a gate that lets this caller see everything.
   * `purpose` is `'read'` by default; the write gate passes `'write'` to get the records the caller may change.
   */
  getGateFilters(purpose?: OnQueryPurpose): Promise<DataFilters<RecordType> | undefined>;
}
