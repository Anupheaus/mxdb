import { useImperativeHandle, forwardRef, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import https from 'https';
import { useMXDB } from '../../../src/client';
import { useCollection } from '../../../src/client/hooks/useCollection';
import {
  DbsProvider,
  ClientToServerProvider,
  ClientToServerSyncProvider,
  ServerToClientProvider,
  useClientToServerSyncInstance,
  useDb,
} from '../../../src/client/providers';
import type { AuditOf, QueryProps } from '../../../src/common';
import { E2E_DEFAULT_CLIENT_DB_PREFIX, E2E_SOCKET_API_NAME } from './mongoConstants';
import type { E2eTestRecord } from './types';
import { e2eTestCollection, type RunLogDetail, type RunLogEvent } from './types';
// Use ES imports so vitest applies resolve aliases (source code), avoiding
// context-identity mismatches between the dist and the source versions.
import { useNexus, Nexus } from '@anupheaus/nexus/client';
import { Logger } from '@anupheaus/common';
import { LoggerProvider } from '@anupheaus/react-ui';
import { waitUntilAsync } from './utils';

/**
 * Obtain a session token from the dev-auth bypass route. Uses https.request so it goes through
 * the preload-tls.cjs patch that sets rejectUnauthorized=false for the self-signed test cert.
 */
const SESSION_COOKIE_PATTERN = /(?:^|;\s*)(?:nexus_session|socketapi_session)=([^;]+)/;

function fetchDevSessionToken(serverUrl: string, userId: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const body = JSON.stringify({ userId });
    const [host, portStr] = serverUrl.split(':');
    const port = portStr != null ? parseInt(portStr, 10) : 443;
    const req = https.request({
      hostname: host,
      port,
      path: `/${E2E_SOCKET_API_NAME}/dev/signin`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(undefined);
          return;
        }
        let fromBody: string | undefined;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { sessionToken?: unknown };
          if (typeof parsed.sessionToken === 'string' && parsed.sessionToken.length > 0) {
            fromBody = parsed.sessionToken;
          }
        } catch {
          // ignore malformed body
        }
        const setCookie = res.headers['set-cookie'];
        const cookieStr = setCookie == null
          ? ''
          : (Array.isArray(setCookie) ? setCookie.join('; ') : setCookie);
        const match = cookieStr.match(SESSION_COOKIE_PATTERN);
        resolve(fromBody ?? match?.[1] ?? undefined);
      });
    });
    req.on('error', () => resolve(undefined));
    req.write(body);
    req.end();
  });
}

export interface SyncClientDriverRef {
  get(recordId: string): Promise<E2eTestRecord | undefined>;
  /** Establishes mxdbGetAllSubscription so server pushes full collection snapshots on DB changes. */
  subscribeGetAll(): Promise<void>;
  getGetAllSubscriptionSnapshot(): E2eTestRecord[];
  upsert(record: E2eTestRecord): Promise<void>;
  remove(recordId: string): Promise<boolean>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  getIsConnected(): boolean;
  getIsSynchronising(): boolean;
  /** Live row from local `DbCollection` (SQLite-backed in-memory cache); pairs with `getLocalAudit`. */
  getLocalRecord(recordId: string): Promise<E2eTestRecord | undefined>;
  /** All live rows from local `DbCollection` (SQLite-backed in-memory cache). */
  getLocalRecords(): Promise<E2eTestRecord[]>;
  /** Pending C2S sync queue size (`ClientToServerSynchronisation` deduped entries). */
  getPendingC2SSyncQueueSize(): number;
  getLocalAudit(recordId: string): Promise<AuditOf<E2eTestRecord> | undefined>;
  /** Establishes a query subscription with optional filters; snapshot updated on every change. */
  subscribeQuery(props?: QueryProps<E2eTestRecord>): Promise<void>;
  /** Latest result from the active query subscription (empty if not yet subscribed). */
  getQuerySnapshot(): { records: E2eTestRecord[]; total: number };
  /** Establishes a distinct subscription for the given field; snapshot updated on every change. */
  subscribeDistinct(field: keyof E2eTestRecord): Promise<void>;
  /** Latest result from the active distinct subscription (empty if not yet subscribed). */
  getDistinctSnapshot(): unknown[];
}

/**
 * Driver component that runs inside MXDBSync and exposes upsert / disconnect / reconnect via ref.
 * Uses real useCollection and useMXDB so the same code path as the app is exercised.
 */
const SyncClientDriverInner = forwardRef<SyncClientDriverRef, { clientId: string; log: (event: RunLogEvent, detail?: RunLogDetail) => void; }>(
  function SyncClientDriverInner({ clientId, log }, ref) {
    const { get, getAll, query, distinct, upsert, remove: collectionRemove, useQuery } = useCollection(e2eTestCollection);
    // Ensure a live query subscription exists so the real sync pipeline is exercised.
    // (Without an active query/subscription, some setups won't push local mutations to the server.)
    useQuery();
    const { disconnect, connect, isSynchronising } = useMXDB();
    const { getIsConnected, getSocket } = useNexus();
    const c2sInstance = useClientToServerSyncInstance();
    const { db } = useDb();
    const getAllSubscriptionRecordsRef = useRef<E2eTestRecord[]>([]);
    const getAllSubscribeLastRef = useRef<E2eTestRecord[] | undefined>(undefined);
    const querySnapshotRef = useRef<{ records: E2eTestRecord[]; total: number }>({ records: [], total: 0 });
    const distinctSnapshotRef = useRef<unknown[]>([]);

    // Instrument socket emits and important socket events for test-owned logging.
    useEffect(() => {
      const socket = getSocket();
      if (!socket) return;

      const originalEmit = socket.emit.bind(socket);
      socket.emit = ((eventName: string, ...args: any[]) => {
        const ts = process.hrtime.bigint().toString();
        const hasAck = typeof args[args.length - 1] === 'function';
        const ack = hasAck ? args[args.length - 1] : undefined;
        const payload = hasAck ? args.slice(0, -1) : args;
        log('socket_emit', { clientId, ts, eventName, payload });
        if (ack) {
          const wrappedAck = (...ackArgs: any[]) => {
            log('socket_ack', { clientId, ts, eventName, ackArgs });
            if (eventName === 'mxdbSyncCollectionsAction' && Array.isArray(ackArgs[0])) {
              const responses = ackArgs[0] as Array<{ collectionName: string; ids: string[]; }>;
              log('sync_ack', { clientId, responses: responses.map(r => ({ collectionName: r.collectionName, acknowledgedCount: r.ids?.length ?? 0, acknowledgedIds: r.ids ?? [] })) });
            }
            return (ack as any)(...ackArgs);
          };
          return originalEmit(eventName, ...payload, wrappedAck);
        }
        return originalEmit(eventName, ...payload);
      }) as any;

      const onConnect = () => log('socket_connect', { clientId, socketId: socket.id });
      const onDisconnect = (reason: any) => log('socket_disconnect', { clientId, reason });
      const onError = (err: any) => log('socket_error', { clientId, error: String(err?.message ?? err) });
      socket.on('connect', onConnect);
      socket.on('disconnect', onDisconnect);
      socket.on('connect_error', onError);
      socket.on('error', onError);

      return () => {
        socket.emit = originalEmit as any;
        socket.off('connect', onConnect);
        socket.off('disconnect', onDisconnect);
        socket.off('connect_error', onError);
        socket.off('error', onError);
      };
    }, [getSocket, getIsConnected, clientId, log]);

    useImperativeHandle(
      ref,
      () => ({
        get(recordId: string) {
          return get(recordId);
        },
        subscribeGetAll() {
          return getAll(
            {},
            records => {
              getAllSubscribeLastRef.current = records;
              getAllSubscriptionRecordsRef.current = records;
            },
            () => {
              if (getAllSubscribeLastRef.current != null) {
                getAllSubscriptionRecordsRef.current = getAllSubscribeLastRef.current;
              }
            },
          );
        },
        getGetAllSubscriptionSnapshot: () => getAllSubscriptionRecordsRef.current ?? [],
        upsert(record: E2eTestRecord) {
          return upsert(record);
        },
        async remove(recordId: string) {
          await collectionRemove(recordId);
          return true;
        },
        async disconnect() {
          disconnect();
          await waitUntilAsync(async () => !getIsConnected(), 'Client disconnected', 30_000);
        },
        async reconnect() {
          connect().catch(() => {}); // rejection handled by waitUntilAsync below
          await waitUntilAsync(async () => getIsConnected(), 'Client reconnected', 30_000);
        },
        getIsConnected,
        getIsSynchronising: () => isSynchronising,
        getLocalRecord(recordId: string) {
          return db.use<E2eTestRecord>(e2eTestCollection.name).get(recordId);
        },
        getLocalRecords() {
          return db.use<E2eTestRecord>(e2eTestCollection.name).getAll();
        },
        getPendingC2SSyncQueueSize: () => c2sInstance?.pendingQueueEntryCount ?? 0,
        getLocalAudit(recordId: string) {
          return db.use<E2eTestRecord>(e2eTestCollection.name).getAudit(recordId);
        },
        subscribeQuery(props?: QueryProps<E2eTestRecord>) {
          return query(
            props ?? {},
            result => { querySnapshotRef.current = result; },
            () => {},
          );
        },
        getQuerySnapshot: () => querySnapshotRef.current,
        subscribeDistinct(field: keyof E2eTestRecord) {
          return distinct(
            field,
            values => { distinctSnapshotRef.current = values as unknown[]; },
          );
        },
        getDistinctSnapshot: () => distinctSnapshotRef.current,
      }),
      [get, getAll, query, distinct, upsert, collectionRemove, disconnect, connect, getIsConnected, isSynchronising, c2sInstance, db],
    );

    return null;
  },
);

export interface SyncClient {
  connect(serverUrl: string): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  get(recordId: string): Promise<E2eTestRecord | undefined>;
  subscribeGetAll(): Promise<void>;
  getGetAllSubscriptionSnapshot(): E2eTestRecord[];
  upsert(record: E2eTestRecord): Promise<void>;
  remove(recordId: string): Promise<boolean>;
  getIsConnected(): boolean;
  getIsSynchronising(): boolean;
  getLocalRecord(recordId: string): Promise<E2eTestRecord | undefined>;
  getLocalRecords(): Promise<E2eTestRecord[]>;
  getPendingC2SSyncQueueSize(): number;
  getLocalAudit(recordId: string): Promise<AuditOf<E2eTestRecord> | undefined>;
  subscribeQuery(props?: QueryProps<E2eTestRecord>): Promise<void>;
  getQuerySnapshot(): { records: E2eTestRecord[]; total: number };
  subscribeDistinct(field: keyof E2eTestRecord): Promise<void>;
  getDistinctSnapshot(): unknown[];
  unmount(): void;
}

export interface CreateSyncClientOptions {
  /** Override IndexedDB / DbsProvider database name (default: `mxdb-e2e-client-${clientId}`). */
  dbName?: string;
  /**
   * Pre-generated 32-byte AES-256-GCM key for the test SQLite database.
   * Must be provided — DbsProvider requires an encryption key and unencrypted
   * storage is not permitted. Generate once per SyncClient via
   * `crypto.getRandomValues(new Uint8Array(32))`.
   */
  encryptionKey: Uint8Array;
}

/**
 * Create a sync client: a React root with MXDBSync and a driver that exposes upsert/disconnect/reconnect.
 * Each client has a unique db name. Call connect(serverUrl) to mount and wait for connection.
 */
export function createSyncClient(
  clientId: string,
  runLogger: { log: (event: RunLogEvent, detail?: RunLogDetail) => void; },
  options: CreateSyncClientOptions,
): SyncClient {
  const dbName = options.dbName ?? `${E2E_DEFAULT_CLIENT_DB_PREFIX}-${clientId}`;
  const encryptionKey = options.encryptionKey;
  const socketName = E2E_SOCKET_API_NAME;
  /** Vitest replaces `Logger` with a subclass that forwards to the file run log (`e2eVitestSetup.ts`). */
  const reactTreeLogger = new Logger(`e2e-client-${clientId}`);
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let driver: SyncClientDriverRef;
  let resolveDriverReady: (() => void) | null = null;
  let driverReadyPromise = new Promise<void>(resolve => {
    resolveDriverReady = resolve;
  });
  let sessionToken: string | undefined;

  function resetDriverReadyPromise(): void {
    driverReadyPromise = new Promise<void>(resolve => {
      resolveDriverReady = resolve;
    });
  }

  async function connect(serverUrl: string): Promise<void> {
    if (container != null) {
      await driverReadyPromise;
      await waitUntilAsync(async () => getIsConnected(), `Client ${clientId} socket connected`, 30_000);
      return;
    }
    sessionToken ??= await fetchDevSessionToken(serverUrl, clientId);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const saveDriver = (innerDriver: SyncClientDriverRef) => {
      driver = innerDriver;
      resolveDriverReady?.();
      resolveDriverReady = null;
    };

    root.render(
      <LoggerProvider logger={reactTreeLogger} loggerName="MXDB">
        <Nexus host={serverUrl} name={socketName} auth={sessionToken != null ? { sessionToken } : undefined}>
          <DbsProvider name={dbName} collections={[e2eTestCollection]} encryptionKey={encryptionKey} logger={reactTreeLogger.createSubLogger('db')}>
            <ClientToServerSyncProvider collections={[e2eTestCollection]}>
              <ClientToServerProvider />
              <ServerToClientProvider />
              <SyncClientDriverInner ref={saveDriver} clientId={clientId} log={runLogger.log} />
            </ClientToServerSyncProvider>
          </DbsProvider>
        </Nexus>
      </LoggerProvider>,
    );

    runLogger.log('client_connect', { clientId, dbName, socketName });
    await driverReadyPromise;
    await waitUntilAsync(async () => getIsConnected(), `Client ${clientId} socket connected`, 30_000);
  }

  async function disconnect() {
    if (driver) await driver.disconnect();
    // no-op: driver not mounted yet
    runLogger.log('client_disconnect', { clientId });
  }

  async function reconnect() {
    if (driver) await driver.reconnect();
    // no-op: driver not mounted yet
  }

  async function get(recordId: string): Promise<E2eTestRecord | undefined> {
    if (!driver) throw new Error(`Client ${clientId}: driver not ready (call connect first)`);
    runLogger.log('client_get_request', { clientId, recordId, mode: 'server' });
    const row = await driver.get(recordId);
    runLogger.log('client_get_response', { clientId, recordId, found: row != null, mode: 'server' });
    return row;
  }

  async function subscribeGetAll(): Promise<void> {
    if (!driver) throw new Error(`Client ${clientId}: driver not ready (call connect first)`);
    runLogger.log('client_getAll_subscribe', { clientId, phase: 'start' });
    await driver.subscribeGetAll();
    const snap = driver.getGetAllSubscriptionSnapshot();
    runLogger.log('client_getAll_subscribe', { clientId, phase: 'ready', recordCount: snap.length });
  }

  function getGetAllSubscriptionSnapshot(): E2eTestRecord[] {
    return driver ? driver.getGetAllSubscriptionSnapshot() : [];
  }

  async function upsert(record: E2eTestRecord): Promise<void> {
    if (!driver) throw new Error(`Client ${clientId}: driver not ready (call connect first)`);
    runLogger.log('client_upsert_request', { clientId, record });
    await driver.upsert(record);
    runLogger.log('client_upsert_response', { clientId, recordId: record.id });
  }

  async function remove(recordId: string): Promise<boolean> {
    if (!driver) throw new Error(`Client ${clientId}: driver not ready (call connect first)`);
    runLogger.log('client_remove_request', { clientId, recordId });
    const result = await driver.remove(recordId);
    runLogger.log('client_remove_response', { clientId, recordId });
    return result;
  }

  function getIsConnected(): boolean {
    return driver ? driver.getIsConnected() : false;
  }

  function getIsSynchronising(): boolean {
    return driver ? driver.getIsSynchronising() : false;
  }

  async function getLocalRecord(recordId: string): Promise<E2eTestRecord | undefined> {
    if (!driver) throw new Error(`Client ${clientId}: driver not ready (call connect first)`);
    return driver.getLocalRecord(recordId);
  }

  async function getLocalRecords(): Promise<E2eTestRecord[]> {
    if (!driver) throw new Error(`Client ${clientId}: driver not ready (call connect first)`);
    return driver.getLocalRecords();
  }

  function getPendingC2SSyncQueueSize(): number {
    return driver ? driver.getPendingC2SSyncQueueSize() : 0;
  }

  async function getLocalAudit(recordId: string): Promise<AuditOf<E2eTestRecord> | undefined> {
    if (!driver) throw new Error(`Client ${clientId}: driver not ready (call connect first)`);
    return driver.getLocalAudit(recordId);
  }

  async function subscribeQuery(props?: QueryProps<E2eTestRecord>): Promise<void> {
    if (!driver) throw new Error(`Client ${clientId}: driver not ready (call connect first)`);
    return driver.subscribeQuery(props);
  }

  function getQuerySnapshot(): { records: E2eTestRecord[]; total: number } {
    return driver ? driver.getQuerySnapshot() : { records: [], total: 0 };
  }

  async function subscribeDistinct(field: keyof E2eTestRecord): Promise<void> {
    if (!driver) throw new Error(`Client ${clientId}: driver not ready (call connect first)`);
    return driver.subscribeDistinct(field);
  }

  function getDistinctSnapshot(): unknown[] {
    return driver ? driver.getDistinctSnapshot() : [];
  }

  function unmount() {
    if (root != null && container != null) {
      root.unmount();
      container.remove();
      root = null;
      container = null;
      resetDriverReadyPromise();
    }
  }

  return {
    connect,
    disconnect,
    reconnect,
    get,
    subscribeGetAll,
    getGetAllSubscriptionSnapshot,
    upsert,
    remove,
    getIsConnected,
    getIsSynchronising,
    getLocalRecord,
    getLocalRecords,
    getPendingC2SSyncQueueSize,
    getLocalAudit,
    subscribeQuery,
    getQuerySnapshot,
    subscribeDistinct,
    getDistinctSnapshot,
    unmount,
  };
}
