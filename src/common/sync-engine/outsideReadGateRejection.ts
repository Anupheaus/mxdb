import type { MXDBSyncRejectedRecord } from './models';

/**
 * The one reason a client is given when it changes a record it may not read: a live record outside its read gate, a
 * deleted record, or an id the server never held. One reason for all three, so a client cannot tell from the answer
 * whether a record it cannot read exists (sc-998). The server logs which case it was.
 */
export const OUTSIDE_READ_GATE_REASON = 'This record can\'t be changed. It may have been deleted, or you may not have access to it.';

/** The client-facing refusal of a change to record `id` outside the caller's read gate. */
export function toOutsideReadGateRejection(id: string): MXDBSyncRejectedRecord {
  return { id, reason: OUTSIDE_READ_GATE_REASON, kind: 'access' };
}
