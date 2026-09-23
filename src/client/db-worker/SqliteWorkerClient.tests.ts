/* eslint-disable max-classes-per-file -- fakes for the browser/driver classes this module talks to */
// Behavioural tests for SqliteWorkerClient in all three modes:
//  - inline    (Node: no Worker global) — runs the real in-process SQLite
//  - dedicated (Worker global, no SharedWorker) — the Worker boundary is replaced by a fake
//  - shared    (SharedWorker global) — the SharedWorker/MessagePort boundary is replaced by a fake
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SqliteWorkerClient } from './SqliteWorkerClient';
import type { WorkerRequest } from './worker-messages';

// ─── Shared helpers ───────────────────────────────────────────────────────────

type MessageListener = (event: { data: unknown }) => void;

interface ReplyOptions {
  result?: unknown;
  error?: string;
}

async function drainMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}

/** Minimal stand-in for either a dedicated Worker or a SharedWorker's MessagePort. */
class FakeChannel {
  posted: WorkerRequest[] = [];
  #listeners: MessageListener[] = [];
  postMessage = vi.fn((message: WorkerRequest) => { this.posted.push(message); });
  addEventListener(type: string, listener: MessageListener): void {
    if (type === 'message') this.#listeners.push(listener);
  }

  /** Deliver a message from the worker side to the client. */
  emit(data: unknown): void {
    this.#listeners.forEach(listener => listener({ data }));
  }

  /** Reply to the most recent request of the given type. */
  reply(type: WorkerRequest['type'], { result = null, error }: ReplyOptions = {}): void {
    const request = [...this.posted].reverse().find(message => message.type === type);
    if (request == null || !('correlationId' in request)) throw new Error(`No "${type}" request has been posted`);
    this.emit(error != null ? { correlationId: request.correlationId, error } : { correlationId: request.correlationId, result });
  }

  typesPosted(): WorkerRequest['type'][] {
    return this.posted.map(({ type }) => type);
  }
}

class FakeDedicatedWorker extends FakeChannel {
  static instances: FakeDedicatedWorker[] = [];
  onerror: ((event: { message?: string }) => void) | null = null;
  terminate = vi.fn();
  constructor() {
    super();
    FakeDedicatedWorker.instances.push(this);
  }
}

class FakePort extends FakeChannel {
  start = vi.fn();
  close = vi.fn();
}

class FakeSharedWorker {
  static instances: FakeSharedWorker[] = [];
  port = new FakePort();
  constructor() {
    FakeSharedWorker.instances.push(this);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeDedicatedWorker.instances = [];
  FakeSharedWorker.instances = [];
});

// ─── Inline mode ──────────────────────────────────────────────────────────────

describe('SqliteWorkerClient (inline mode)', () => {
  const DDL = ['CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT)'];

  async function openClient(): Promise<SqliteWorkerClient> {
    const client = new SqliteWorkerClient();
    await client.open('inline-db', DDL);
    return client;
  }

  it('reads back rows written with exec', async () => {
    const client = await openClient();

    await client.exec('INSERT INTO items(id, name) VALUES (?, ?)', ['a', 'Alice']);

    expect(await client.query('SELECT id, name FROM items')).toEqual([{ id: 'a', name: 'Alice' }]);
  });

  it('writes every statement of a batch', async () => {
    const client = await openClient();

    await client.execBatch([
      { sql: 'INSERT INTO items(id, name) VALUES (?, ?)', params: ['a', 'Alice'] },
      { sql: 'INSERT INTO items(id, name) VALUES (\'b\', \'Bob\')' },
    ]);

    expect(await client.query('SELECT id FROM items ORDER BY id')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('rolls back the whole batch when one statement fails', async () => {
    const client = await openClient();

    const batch = client.execBatch([
      { sql: 'INSERT INTO items(id, name) VALUES (?, ?)', params: ['a', 'Alice'] },
      { sql: 'INSERT INTO items(id, name) VALUES (?, ?)', params: ['a', 'Duplicate'] },
    ]);

    await expect(batch).rejects.toThrow(/UNIQUE constraint failed/);
    expect(await client.query('SELECT id FROM items')).toEqual([]);
  });

  it('returns one result set per query from queryMulti', async () => {
    const client = await openClient();
    await client.exec('INSERT INTO items(id, name) VALUES (\'a\', \'Alice\')');

    const results = await client.queryMulti([
      { sql: 'SELECT COUNT(*) AS total FROM items' },
      { sql: 'SELECT name FROM items WHERE id = ?', params: ['a'] },
    ]);

    expect(results).toEqual([[{ total: 1 }], [{ name: 'Alice' }]]);
  });

  it.each([
    ['a matching pattern', '^Al', 1],
    ['a non-matching pattern', '^Bo', 0],
    ['an invalid pattern', '([', 0],
  ])('supports REGEXP in SQL with %s', async (_label, pattern, expectedCount) => {
    const client = await openClient();
    await client.exec('INSERT INTO items(id, name) VALUES (\'a\', \'Alice\')');

    const [row] = await client.query<{ total: number }>('SELECT COUNT(*) AS total FROM items WHERE name REGEXP ?', [pattern]);

    expect(row?.total).toBe(expectedCount);
  });

  it('starts from an empty database when opened again', async () => {
    const client = await openClient();
    await client.exec('INSERT INTO items(id, name) VALUES (\'a\', \'Alice\')');

    await client.open('inline-db', DDL);

    expect(await client.query('SELECT id FROM items')).toEqual([]);
  });

  const operationsBeforeOpen: [string, (client: SqliteWorkerClient) => Promise<unknown>][] = [
    ['exec', client => client.exec('SELECT 1')],
    ['execBatch', client => client.execBatch([{ sql: 'SELECT 1' }])],
    ['query', client => client.query('SELECT 1')],
    ['queryMulti', client => client.queryMulti([{ sql: 'SELECT 1' }])],
  ];

  it.each(operationsBeforeOpen)('rejects %s before the database is opened', async (_label, operation) => {
    const client = new SqliteWorkerClient();

    await expect(operation(client)).rejects.toThrow('Database not open');
  });

  it.each(operationsBeforeOpen)('rejects %s after the database is closed', async (_label, operation) => {
    const client = await openClient();
    await client.close();

    await expect(operation(client)).rejects.toThrow('Database not open');
  });

  it('allows closing a database that was never opened', async () => {
    const client = new SqliteWorkerClient();

    await expect(client.close()).resolves.toBeUndefined();
  });
});

// ─── Dedicated worker mode ────────────────────────────────────────────────────

describe('SqliteWorkerClient (dedicated worker mode)', () => {
  function createClient(encryptionKey?: Uint8Array): SqliteWorkerClient {
    vi.stubGlobal('Worker', FakeDedicatedWorker);
    vi.stubGlobal('SharedWorker', undefined);
    return new SqliteWorkerClient({ encryptionKey });
  }

  function currentWorker(): FakeDedicatedWorker {
    const worker = FakeDedicatedWorker.instances.at(-1);
    if (worker == null) throw new Error('No worker has been created');
    return worker;
  }

  it('sends an open request carrying the database name, DDL and encryption key', async () => {
    const encryptionKey = new Uint8Array([1, 2, 3]);
    const client = createClient(encryptionKey);

    const opening = client.open('db-1', ['CREATE TABLE t (id TEXT)']);
    currentWorker().reply('open');
    await opening;

    expect(currentWorker().posted[0]).toMatchObject({ type: 'open', dbName: 'db-1', statements: ['CREATE TABLE t (id TEXT)'], encryptionKey });
  });

  it('resolves a query with the rows the worker returns', async () => {
    const client = createClient();

    const querying = client.query('SELECT * FROM t', [1]);
    currentWorker().reply('query', { result: [{ id: 'a' }] });

    expect(await querying).toEqual([{ id: 'a' }]);
  });

  it('sends the SQL, params and collection hint for each request type', async () => {
    const client = createClient();

    void client.exec('UPDATE t SET x = ?', [1], 'things');
    void client.execBatch([{ sql: 'DELETE FROM t' }], 'things');
    void client.query('SELECT 1', [2]);
    void client.queryMulti([{ sql: 'SELECT 2' }]);
    await drainMicrotasks();

    expect(currentWorker().posted.map(({ correlationId: _correlationId, ...request }: WorkerRequest & { correlationId?: string }) => request)).toEqual([
      { type: 'exec', sql: 'UPDATE t SET x = ?', params: [1], collectionHint: 'things' },
      { type: 'exec-batch', statements: [{ sql: 'DELETE FROM t' }], collectionHint: 'things' },
      { type: 'query', sql: 'SELECT 1', params: [2] },
      { type: 'query-multi', queries: [{ sql: 'SELECT 2' }] },
    ]);
  });

  it('gives every request a unique correlation id', async () => {
    const client = createClient();

    void client.query('SELECT 1');
    void client.query('SELECT 2');
    await drainMicrotasks();

    const [first, second] = currentWorker().posted as Array<{ correlationId: string }>;
    expect(first?.correlationId).not.toBe(second?.correlationId);
  });

  it('resolves each response to the request with the matching correlation id', async () => {
    const client = createClient();
    const first = client.query('SELECT 1');
    const second = client.query('SELECT 2');
    const [firstRequest, secondRequest] = currentWorker().posted as Array<{ correlationId: string }>;

    currentWorker().emit({ correlationId: secondRequest!.correlationId, result: ['second'] });
    currentWorker().emit({ correlationId: firstRequest!.correlationId, result: ['first'] });

    expect([await first, await second]).toEqual([['first'], ['second']]);
  });

  it('rejects a request with the error message the worker returns', async () => {
    const client = createClient();

    const querying = client.query('SELECT nonsense');
    currentWorker().reply('query', { error: 'no such column: nonsense' });

    await expect(querying).rejects.toThrow('no such column: nonsense');
  });

  it('ignores responses whose correlation id matches no pending request', async () => {
    const client = createClient();
    const querying = client.query('SELECT 1');

    currentWorker().emit({ correlationId: 'unknown', result: ['wrong'] });
    currentWorker().reply('query', { result: ['right'] });

    expect(await querying).toEqual(['right']);
  });

  it.each([
    ['the worker error message', { message: 'boom' }, 'boom'],
    ['a generic message when the error has none', {}, 'Worker error'],
  ])('rejects every in-flight request with %s when the worker errors', async (_label, errorEvent, expectedMessage) => {
    const client = createClient();
    const first = client.query('SELECT 1');
    const second = client.exec('SELECT 2');

    currentWorker().onerror?.(errorEvent);

    await expect(Promise.allSettled([first, second])).resolves.toEqual([
      { status: 'rejected', reason: new Error(expectedMessage) },
      { status: 'rejected', reason: new Error(expectedMessage) },
    ]);
  });

  it('reuses one worker for all requests', async () => {
    const client = createClient();

    void client.query('SELECT 1');
    void client.query('SELECT 2');
    await drainMicrotasks();

    expect(FakeDedicatedWorker.instances).toHaveLength(1);
  });

  it('sends a close request and terminates the worker on close', async () => {
    const client = createClient();

    const closing = client.close();
    const worker = currentWorker();
    worker.reply('close');
    await closing;

    expect([worker.typesPosted(), worker.terminate.mock.calls.length]).toEqual([['close'], 1]);
  });

  it('starts a new worker for requests made after close', async () => {
    const client = createClient();
    const closing = client.close();
    currentWorker().reply('close');
    await closing;

    void client.query('SELECT 1');

    expect(FakeDedicatedWorker.instances).toHaveLength(2);
  });

  it.each([
    ['the collection name', { type: 'change-notification', collectionName: 'things' }, 'things'],
    ['an empty name when none is given', { type: 'change-notification' }, ''],
  ])('notifies the external-change handler with %s', async (_label, notification, expectedName) => {
    const client = createClient();
    const handler = vi.fn();
    client.setOnExternalChange(handler);
    void client.query('SELECT 1');

    currentWorker().emit(notification);

    expect(handler).toHaveBeenCalledWith(expectedName);
  });

  it('does not fail on a change notification when no external-change handler is registered', () => {
    const client = createClient();
    void client.query('SELECT 1');

    expect(() => currentWorker().emit({ type: 'change-notification', collectionName: 'things' })).not.toThrow();
  });
});

// ─── Shared worker mode ───────────────────────────────────────────────────────

describe('SqliteWorkerClient (shared worker mode)', () => {
  const PORT_ID = 'port-7';

  interface SharedClientFixture {
    client: SqliteWorkerClient;
    addEventListener: ReturnType<typeof vi.fn>;
  }

  function createClient(): SharedClientFixture {
    const addEventListener = vi.fn();
    vi.stubGlobal('Worker', FakeDedicatedWorker);
    vi.stubGlobal('SharedWorker', FakeSharedWorker);
    vi.stubGlobal('addEventListener', addEventListener);
    return { client: new SqliteWorkerClient(), addEventListener };
  }

  function currentPort(): FakePort {
    const sharedWorker = FakeSharedWorker.instances.at(-1);
    if (sharedWorker == null) throw new Error('No shared worker has been created');
    return sharedWorker.port;
  }

  /** Complete the connect handshake the client sends when it first needs the shared worker. */
  async function acceptConnection(): Promise<void> {
    await drainMicrotasks();
    currentPort().reply('connect', { result: PORT_ID });
    await drainMicrotasks();
  }

  async function openClient(): Promise<SharedClientFixture> {
    const fixture = createClient();
    const opening = fixture.client.open('shared-db', []);
    await acceptConnection();
    currentPort().reply('open');
    await opening;
    return fixture;
  }

  it('connects to the shared worker and then sends the open request', async () => {
    await openClient();

    expect(currentPort().typesPosted()).toEqual(['connect', 'open']);
  });

  it('starts the port so it can receive messages', async () => {
    await openClient();

    expect(currentPort().start).toHaveBeenCalledTimes(1);
  });

  it('does not send the open request until the connect handshake completes', async () => {
    const { client } = createClient();

    void client.open('shared-db', []);
    await drainMicrotasks();

    expect(currentPort().typesPosted()).toEqual(['connect']);
  });

  it('connects first when a query is issued before open', async () => {
    const { client } = createClient();

    const querying = client.query('SELECT 1');
    await acceptConnection();
    currentPort().reply('query', { result: [{ one: 1 }] });

    expect([await querying, currentPort().typesPosted()]).toEqual([[{ one: 1 }], ['connect', 'query']]);
  });

  it('connects only once across many requests', async () => {
    const { client } = await openClient();

    void client.query('SELECT 1');
    void client.exec('SELECT 2');
    await drainMicrotasks();

    expect([FakeSharedWorker.instances.length, currentPort().typesPosted()]).toEqual([1, ['connect', 'open', 'query', 'exec']]);
  });

  it('tells the shared worker to drop this tab\'s port when the page unloads', async () => {
    const { addEventListener } = await openClient();
    const [eventName, onBeforeUnload] = addEventListener.mock.calls[0]!;

    onBeforeUnload();

    expect([eventName, currentPort().posted.at(-1)]).toEqual(['beforeunload', { type: 'disconnect', portId: PORT_ID }]);
  });

  it('sends nothing on unload when the connect handshake never completed', async () => {
    const { client, addEventListener } = createClient();
    void client.open('shared-db', []);
    await drainMicrotasks();
    const [, onBeforeUnload] = addEventListener.mock.calls[0]!;

    onBeforeUnload();

    expect(currentPort().typesPosted()).toEqual(['connect']);
  });

  it('rejects open when the connect handshake fails', async () => {
    const { client } = createClient();

    const opening = client.open('shared-db', []);
    await drainMicrotasks();
    currentPort().reply('connect', { error: 'too many tabs' });

    await expect(opening).rejects.toThrow('too many tabs');
  });

  it('closes the database, disconnects and closes the port on close', async () => {
    const { client } = await openClient();
    const port = currentPort();

    const closing = client.close();
    await drainMicrotasks();
    port.reply('close');
    await closing;

    expect([port.posted.slice(-2).map(({ type }) => type), port.posted.at(-1), port.close.mock.calls.length])
      .toEqual([['close', 'disconnect'], { type: 'disconnect', portId: PORT_ID }, 1]);
  });

  it('reconnects with a new shared worker for requests made after close', async () => {
    const { client } = await openClient();
    const closing = client.close();
    await drainMicrotasks();
    currentPort().reply('close');
    await closing;

    void client.query('SELECT 1');
    await drainMicrotasks();

    expect([FakeSharedWorker.instances.length, currentPort().typesPosted()]).toEqual([2, ['connect']]);
  });

  it('notifies the external-change handler when another tab writes', async () => {
    const { client } = await openClient();
    const handler = vi.fn();
    client.setOnExternalChange(handler);

    currentPort().emit({ type: 'change-notification', collectionName: 'things' });

    expect(handler).toHaveBeenCalledWith('things');
  });
});
