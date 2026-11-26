/* eslint-disable max-classes-per-file -- fakes for the browser classes the workers talk to */
// The real worker entry points (sqlite-worker.ts and sqlite-shared-worker.ts), run in Node with real SQLite and real
// WebCrypto; only OPFS and the worker globals are faked. A worker is "stopped" by copying OPFS as it is at that moment
// and starting a fresh worker module on the copy, as a reload does: the old worker's pending snapshot never lands.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulidx';
import type { WorkerRequestWithCorrelationId, WorkerResponse } from './worker-messages';

// ─── Fake OPFS ────────────────────────────────────────────────────────────────

class FakeDirectory {
  files = new Map<string, Uint8Array>();
  directories = new Map<string, FakeDirectory>();

  async getDirectoryHandle(name: string, { create = false }: { create?: boolean } = {}): Promise<FakeDirectory> {
    let directory = this.directories.get(name);
    if (directory == null) {
      if (!create) throw new DOMException(`Directory "${name}" not found`, 'NotFoundError');
      directory = new FakeDirectory();
      this.directories.set(name, directory);
    }
    return directory;
  }

  async getFileHandle(name: string, { create = false }: { create?: boolean } = {}) {
    if (!this.files.has(name)) {
      if (!create) throw new DOMException(`File "${name}" not found`, 'NotFoundError');
      this.files.set(name, new Uint8Array());
    }
    return {
      getFile: async () => {
        const bytes = this.files.get(name)!;
        return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      },
      createWritable: async () => {
        // Like OPFS: the writes go to a swap copy that replaces the file only on close.
        let swap = new Uint8Array();
        return {
          write: async (data: ArrayBuffer | Uint8Array) => {
            const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
            const combined = new Uint8Array(swap.byteLength + chunk.byteLength);
            combined.set(swap, 0);
            combined.set(chunk, swap.byteLength);
            swap = combined;
          },
          close: async () => { this.files.set(name, swap); },
          abort: async () => { /* the swap copy is dropped */ },
        };
      },
    };
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name) && !this.directories.delete(name)) throw new DOMException(`"${name}" not found`, 'NotFoundError');
  }

  async* keys(): AsyncIterable<string> {
    yield* this.files.keys();
    yield* this.directories.keys();
  }

  /** OPFS exactly as it is now, as the next page load would find it. */
  copy(): FakeDirectory {
    const copied = new FakeDirectory();
    for (const [name, bytes] of this.files) copied.files.set(name, bytes.slice());
    for (const [name, directory] of this.directories) copied.directories.set(name, directory.copy());
    return copied;
  }
}

// ─── Worker harness ───────────────────────────────────────────────────────────

type MessageListener = (event: { data: unknown }) => void;

/** A request as a test writes it: the harness adds the correlation id (distributes over the request union). */
type RequestBody = WorkerRequestWithCorrelationId extends infer Request ? Request extends WorkerRequestWithCorrelationId ? Omit<Request, 'correlationId'> : never : never;

interface RunningWorker {
  request<Result = unknown>(message: RequestBody): Promise<Result>;
}

/** The global scope a worker module sees: `self` with postMessage / addEventListener (dedicated) or onconnect (shared). */
class FakeWorkerScope {
  listeners: MessageListener[] = [];
  posted: unknown[] = [];
  onconnect: ((event: { ports: FakePort[] }) => void) | null = null;
  addEventListener(type: string, listener: MessageListener): void {
    if (type === 'message') this.listeners.push(listener);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
    this.onPost?.(message);
  }
  onPost: ((message: unknown) => void) | null = null;
}

class FakePort {
  listeners: MessageListener[] = [];
  onPost: ((message: unknown) => void) | null = null;
  start(): void { /* nothing to start */ }
  addEventListener(type: string, listener: MessageListener): void {
    if (type === 'message') this.listeners.push(listener);
  }
  postMessage(message: unknown): void { this.onPost?.(message); }
  deliver(data: unknown): void { this.listeners.forEach(listener => listener({ data })); }
}

function requester(send: (message: unknown) => void, setOnReply: (handler: (message: unknown) => void) => void): RunningWorker['request'] {
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  setOnReply(message => {
    const { correlationId, result, error } = message as WorkerResponse;
    const waiting = pending.get(correlationId);
    if (waiting == null) return;
    pending.delete(correlationId);
    if (error != null) waiting.reject(new Error(error));
    else waiting.resolve(result);
  });
  return <Result,>(message: RequestBody) => new Promise<Result>((resolve, reject) => {
    const correlationId = ulid();
    pending.set(correlationId, { resolve: value => resolve(value as Result), reject });
    send({ ...message, correlationId });
  });
}

/** Loads a fresh copy of a worker module against `opfs`, as a new page's worker would start. */
async function startWorker(kind: 'dedicated' | 'shared', opfs: FakeDirectory): Promise<RunningWorker> {
  vi.resetModules();
  const scope = new FakeWorkerScope();
  vi.stubGlobal('self', scope);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs } });
  if (kind === 'dedicated') {
    await import('./sqlite-worker');
    const request = requester(message => scope.listeners.forEach(listener => listener({ data: message })), handler => { scope.onPost = handler; });
    return { request };
  }
  await import('./sqlite-shared-worker');
  const port = new FakePort();
  scope.onconnect!({ ports: [port] });
  const request = requester(message => port.deliver(message), handler => { port.onPost = handler; });
  await request({ type: 'connect' });
  return { request };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const KEY = new Uint8Array(32).fill(5);
const DB_NAME = 'device-db';
const DDL = ['CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT, edits INTEGER NOT NULL DEFAULT 0)'];

async function openNotes(worker: RunningWorker): Promise<void> {
  await worker.request({ type: 'open', dbName: DB_NAME, statements: DDL, encryptionKey: KEY });
}

async function notesIn(worker: RunningWorker): Promise<Array<{ id: string; body: string; edits: number }>> {
  return worker.request({ type: 'query', sql: 'SELECT id, body, edits FROM notes ORDER BY id' });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => { /* the workers' lock diagnostics */ });
  vi.spyOn(console, 'error').mockImplementation(() => { /* reported problems are asserted where they matter */ });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(['dedicated', 'shared'] as const)('the %s SQLite worker, stopped straight after a write is answered', kind => {
  it('keeps the write: the next worker starts with it', async () => {
    const opfs = new FakeDirectory();
    const first = await startWorker(kind, opfs);
    await openNotes(first);

    await first.request({ type: 'exec', sql: 'INSERT INTO notes (id, body) VALUES (?, ?)', params: ['n1', 'Measure the bay window'] });
    await first.request({
      type: 'exec-batch',
      statements: [
        { sql: 'INSERT INTO notes (id, body) VALUES (?, ?)', params: ['n2', 'Bring samples'] },
        { sql: 'UPDATE notes SET edits = edits + 1 WHERE id = ?', params: ['n1'] },
      ],
    });
    const afterReload = await startWorker(kind, opfs.copy());
    await openNotes(afterReload);

    expect(await notesIn(afterReload)).toEqual([
      { id: 'n1', body: 'Measure the bay window', edits: 1 },
      { id: 'n2', body: 'Bring samples', edits: 0 },
    ]);
  });

  it('keeps writes made after a snapshot, and replays none twice', async () => {
    const opfs = new FakeDirectory();
    const first = await startWorker(kind, opfs);
    await openNotes(first);
    await first.request({ type: 'exec', sql: 'INSERT INTO notes (id, body) VALUES (?, ?)', params: ['n1', 'Before the snapshot'] });
    await first.request({ type: 'exec', sql: 'UPDATE notes SET edits = edits + 1 WHERE id = ?', params: ['n1'] });
    await first.request({ type: 'flush' });

    await first.request({ type: 'exec', sql: 'UPDATE notes SET edits = edits + 1 WHERE id = ?', params: ['n1'] });
    const afterReload = await startWorker(kind, opfs.copy());
    await openNotes(afterReload);

    expect(await notesIn(afterReload)).toEqual([{ id: 'n1', body: 'Before the snapshot', edits: 2 }]);
  });

  it('keeps the writes across two reloads in a row, each straight after a write', async () => {
    const opfs = new FakeDirectory();
    const first = await startWorker(kind, opfs);
    await openNotes(first);
    await first.request({ type: 'exec', sql: 'INSERT INTO notes (id, body) VALUES (?, ?)', params: ['n1', 'First visit'] });

    // The second page reopens (replaying the log) and writes again before its own snapshot lands.
    const secondOpfs = opfs.copy();
    const second = await startWorker(kind, secondOpfs);
    await openNotes(second);
    await second.request({ type: 'exec', sql: 'UPDATE notes SET edits = edits + 1 WHERE id = ?', params: ['n1'] });
    const third = await startWorker(kind, secondOpfs.copy());
    await openNotes(third);

    expect(await notesIn(third)).toEqual([{ id: 'n1', body: 'First visit', edits: 1 }]);
  });

  it('never writes a logged change to OPFS in plain text', async () => {
    const opfs = new FakeDirectory();
    const worker = await startWorker(kind, opfs);
    await openNotes(worker);

    await worker.request({ type: 'exec', sql: 'INSERT INTO notes (id, body) VALUES (?, ?)', params: ['n1', 'secret-customer-name'] });

    const logFiles = [...(opfs.directories.get(`${DB_NAME}.wal`)?.files.values() ?? [])];
    const asText = logFiles.map(bytes => Buffer.from(bytes).toString('latin1'));
    expect([logFiles.length > 0, asText.some(text => text.includes('secret-customer-name') || text.includes('INSERT'))]).toEqual([true, false]);
  });
});
