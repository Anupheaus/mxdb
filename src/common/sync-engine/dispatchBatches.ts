import { to } from '@anupheaus/common';
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
 * The most one record's own dispatch may be, on the wire. A record bigger than {@link MAX_DISPATCH_BYTES} is sent in an
 * emit of its own; one bigger than this could never get through the socket (10 MB, less 1 MB for the envelope), so it
 * is refused locally instead of blocking the rest.
 */
export const MAX_RECORD_DISPATCH_BYTES = 9 * 1024 * 1024;

/**
 * A change too large to ever reach the server (sc-623). It is not sent and not retried: its pending audit carries the
 * oversize entry, so a later, smaller edit does not help either — someone has to deal with it (reduce what it holds, or
 * clear the device's pending change).
 */
export interface MXDBSyncTooLarge {
  collectionName: string;
  recordId: string;
  /** What its dispatch would be on the wire. */
  bytes: number;
  /** The most one record may be. */
  limitBytes: number;
}

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

/** A string's length in UTF-8 bytes, worked out without encoding it. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      // A surrogate pair: one four-byte character
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * What a value costs on the wire, in bytes. nexus sends a payload as `to.serialise(...)` — a JSON string — and
 * socket.io's parser JSON-encodes that string again, so every `"` and `\` in it costs one byte more: an escaped or
 * embedded-JSON string can come close to twice its single-encoded size.
 */
export function estimateDispatchBytes(value: unknown): number {
  const serialised = to.serialise(value) ?? '';
  let escaped = 0;
  for (let index = 0; index < serialised.length; index += 1) {
    const code = serialised.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) escaped += 1;
  }
  return utf8Length(serialised) + escaped + 2;
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
