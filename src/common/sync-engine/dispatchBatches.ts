import type { ClientDispatcherRequest, MXDBRecordStates } from './models';

/** One record's state as the dispatcher holds it. */
type MXDBRecordState = MXDBRecordStates[number]['records'][number];

/**
 * The most one client→server sync emit carries (sc-623). nexus closes a socket whose message passes 10 MB
 * (`maxHttpBufferSize`), and the same oversize payload would then be retried forever — nothing on that device would
 * sync again. 4 MB leaves room for the envelope and for the estimate being an estimate.
 */
export const MAX_DISPATCH_BYTES = 4 * 1024 * 1024;

/**
 * The most one record's own dispatch may be. A record bigger than {@link MAX_DISPATCH_BYTES} is sent in an emit of its
 * own; one bigger than this could never get through the socket, so it is refused locally instead of blocking the rest.
 */
export const MAX_RECORD_DISPATCH_BYTES = 9 * 1024 * 1024;

/** One record's part of a dispatch: its state, what is sent for it, and how big that is. */
export interface DispatchRecord {
  collectionName: string;
  state: MXDBRecordState;
  entry: ClientDispatcherRequest[number]['records'][number];
  bytes: number;
}

/** One emit: the records' states (to settle once the server answers) and the request that carries them. */
export interface DispatchBatch {
  states: MXDBRecordStates;
  request: ClientDispatcherRequest;
  bytes: number;
}

export interface DispatchBatchLimits {
  maxBatchBytes: number;
  maxRecordBytes: number;
}

const encoder = new TextEncoder();

/** The size of a value once serialised to JSON, in UTF-8 bytes — what the socket carries, near enough. */
export function estimateDispatchBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? '').length;
}

/**
 * Splits a dispatch into emits of at most `maxBatchBytes`, in the order given. Each record goes whole into exactly one
 * emit — its audit entries are never split, so its changes still reach the server in order — and a record bigger than
 * `maxBatchBytes` goes in an emit of its own. A record bigger than `maxRecordBytes` is not sent at all: it is returned
 * in `oversize` for the caller to refuse.
 */
export function batchDispatchRecords(records: DispatchRecord[], { maxBatchBytes, maxRecordBytes }: DispatchBatchLimits): { batches: DispatchBatch[]; oversize: DispatchRecord[] } {
  const batches: DispatchBatch[] = [];
  const oversize: DispatchRecord[] = [];
  let current: DispatchRecord[] = [];
  let currentBytes = 0;

  const flush = () => {
    if (current.length === 0) return;
    batches.push(toBatch(current, currentBytes));
    current = [];
    currentBytes = 0;
  };

  for (const record of records) {
    if (record.bytes > maxRecordBytes) {
      oversize.push(record);
      continue;
    }
    if (current.length > 0 && currentBytes + record.bytes > maxBatchBytes) flush();
    current.push(record);
    currentBytes += record.bytes;
  }
  flush();
  return { batches, oversize };
}

/** A batch's records grouped back by collection, in the order they came. */
function toBatch(records: DispatchRecord[], bytes: number): DispatchBatch {
  const states: MXDBRecordStates = [];
  const request: ClientDispatcherRequest = [];
  for (const { collectionName, state, entry } of records) {
    let stateGroup = states.find(group => group.collectionName === collectionName);
    let requestGroup = request.find(group => group.collectionName === collectionName);
    if (stateGroup == null) {
      stateGroup = { collectionName, records: [] };
      states.push(stateGroup);
    }
    if (requestGroup == null) {
      requestGroup = { collectionName, records: [] };
      request.push(requestGroup);
    }
    stateGroup.records.push(state);
    requestGroup.records.push(entry);
  }
  return { states, request, bytes };
}
