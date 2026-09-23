import { createComponent, useLogger } from '@anupheaus/react-ui';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useAction, useNexus } from '@anupheaus/nexus/client';
import { mxdbClientToServerSyncAction } from '../../../common';
import type { MXDBCollection, MXDBError } from '../../../common';
import type { Record as MXDBRecord } from '@anupheaus/common';
import {
  ClientReceiver,
  type MXDBRecordStates,
  type MXDBRecordStatesRequest,
  type MXDBSyncEngineResponse,
  type MXDBUpdateRequest,
} from '../../../common/sync-engine';
import { ClientToServerSynchronisation } from './ClientToServerSynchronisation';
import { ClientToServerSyncInstanceContext } from './useClientToServerSyncInstance';
import { ClientReceiverContext } from '../server-to-client/ClientReceiverContext';
import { SyncStateContext } from './SyncStateContext';
import { useDb } from '../dbs';
import { ACTION_TIMEOUT_MS, withTimeout } from '../../utils/actionTimeout';

interface Props {
  collections: MXDBCollection[];
  onError?(error: MXDBError): void;
  /** Called when the server rejects a dispatch with an AuthenticationError.
   *  Typically triggers a sign-out so the user is prompted to re-authenticate. */
  onUnauthorized?(): void;
  children?: ReactNode;
}

/**
 * Owns the client sync-engine lifecycle for a single MXDBSync mount.
 *
 * Constructs a matched pair of {@link ClientReceiver} and {@link ClientToServerSynchronisation}
 * (which wraps {@link ClientDispatcher}) and ties their lifecycle to the socket connection.
 *
 * - The CR is exposed to {@link ServerToClientProvider} via {@link ClientReceiverContext}.
 * - The wrapper is exposed to {@link ClientToServerProvider} for record enqueue on local mutation.
 */
export const ClientToServerSyncProvider = createComponent('ClientToServerSyncProvider', ({
  collections,
  onError,
  onUnauthorized,
  children,
}: Props) => {
  const { db } = useDb();
  const { onConnectionStateChanged, getIsConnected } = useNexus();
  const { mxdbClientToServerSyncAction: sendBatch } = useAction(mxdbClientToServerSyncAction);
  const logger = useLogger('sync-engine');

  const { cr, c2s } = useMemo(() => {
    const crLogger = logger.createSubLogger('cr');

    // Different clients (e.g. mobile vs web) register different collection lists, yet the server may push
    // records for any collection the user can see. Returns undefined for a collection this client doesn't
    // hold so the push can skip it rather than fail as a whole. Db exposes no non-throwing lookup, and
    // `use` only throws for an unregistered collection, so swallowing the error here is safe.
    const findCollection = <T extends MXDBRecord>(collectionName: string) => {
      try { return db.use<T>(collectionName); }
      catch { return undefined; }
    };

    const cr = new ClientReceiver(crLogger, {
      onRetrieve: <T extends MXDBRecord>(request: MXDBRecordStatesRequest): MXDBRecordStates<T> => {
        const out: MXDBRecordStates<T> = [];
        for (const item of request) {
          const { collectionName, recordIds } = item;
          const collection = findCollection<T>(collectionName);
          if (collection == null) {
            // onRetrieve runs once per push, so this warns once per push per unregistered collection.
            crLogger.warn('Skipping server push for a collection this client has not registered', { collectionName, recordCount: recordIds.length });
            continue;
          }
          const states = collection.getStatesSync(recordIds);
          if (states.length > 0) out.push({ collectionName, records: states });
        }
        return out;
      },
      onUpdate: (updates: MXDBUpdateRequest): MXDBSyncEngineResponse => {
        const response: MXDBSyncEngineResponse = [];
        for (const item of updates) {
          const collection = findCollection(item.collectionName);
          if (collection == null) {
            // Decline (never acknowledge) records this client can't store: the ServerDispatcher then stops
            // re-sending them without counting them as a stuck client. Reporting nothing would make it retry
            // every push until its ignore cap trips; reporting success would claim a write that never happened.
            const declinedRecordIds = [...(item.records ?? []).map(({ record }) => record.id), ...(item.deletedRecordIds ?? [])];
            response.push({ collectionName: item.collectionName, successfulRecordIds: [], declinedRecordIds });
            continue;
          }
          const successfulRecordIds: string[] = [];
          if ((item.records?.length ?? 0) > 0) {
            // Use batch method: one exec-batch + one onChange instead of N of each.
            // This prevents reconciliation with N records from queueing N SQLite writes
            // (and N OPFS flushes with encryption) before any query can run.
            collection.batchApplyServerWriteSync(item.records!);
            successfulRecordIds.push(...item.records!.map(r => r.record.id));
          }
          if ((item.deletedRecordIds?.length ?? 0) > 0) {
            collection.applyServerDeleteSync(item.deletedRecordIds!);
            successfulRecordIds.push(...item.deletedRecordIds!);
          }
          response.push({ collectionName: item.collectionName, successfulRecordIds });
        }
        return response;
      },
    });
    const c2s = new ClientToServerSynchronisation({
      clientReceiver: cr,
      sendBatch: request => withTimeout(sendBatch(request), ACTION_TIMEOUT_MS, 'mxdbClientToServerSyncAction'),
      getDb: () => db,
      collections,
      logger: logger.createSubLogger('c2s'),
      onUnauthorized,
    });
    return { cr, c2s };
    // Rebuilt per Db instance: DbsProvider swaps the Db whenever the encryption key changes (it can be
    // applied twice in quick succession on sign-in/registration). An engine kept from the first render
    // stays bound to the replaced Db — closed mid-open — and start() waits forever on its collections
    // (sync never starts → "Authenticating, please wait...").
  }, [db]);

  // Close the engine for a replaced Db (and on unmount).
  useEffect(() => () => c2s.close(), [c2s]);

  // Track dispatching state for consumers (useMXDB)
  const [isDispatching, setIsDispatching] = useState(false);
  useEffect(() => c2s.onDispatchingChanged(setIsDispatching), [c2s]);

  onConnectionStateChanged((isConnected: boolean) => {
    if (isConnected) void c2s.start().catch(error => onError?.({
      code: 'SYNC_FAILED',
      message: error instanceof Error ? error.message : String(error),
      severity: 'error',
      originalError: error,
    }));
    else c2s.stop();
  });

  // Start each engine (the first, and any rebuilt for a new Db) if already connected — the
  // connection-state callback above only fires on transitions.
  useEffect(() => {
    if (getIsConnected()) {
      void c2s.start().catch(error => onError?.({
        code: 'SYNC_FAILED',
        message: error instanceof Error ? error.message : String(error),
        severity: 'error',
        originalError: error,
      }));
    }
  }, [c2s]);

  const syncStateValue = useMemo(() => ({
    isSyncing: isDispatching,
    onSyncStateChanged: (listener: (s: boolean) => void) => c2s.onDispatchingChanged(listener),
  }), [c2s, isDispatching]);

  return (
    <ClientToServerSyncInstanceContext.Provider value={c2s}>
      <ClientReceiverContext.Provider value={cr}>
        <SyncStateContext.Provider value={syncStateValue}>
          {children}
        </SyncStateContext.Provider>
      </ClientReceiverContext.Provider>
    </ClientToServerSyncInstanceContext.Provider>
  );
});
