import { createComponent, useLogger, useOnUnmount } from '@anupheaus/react-ui';
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
  children,
}: Props) => {
  const { db } = useDb();
  const { onConnectionStateChanged, getIsConnected } = useNexus();
  const { mxdbClientToServerSyncAction: sendBatch } = useAction(mxdbClientToServerSyncAction);
  const logger = useLogger('sync-engine');

  const { cr, c2s } = useMemo(() => {
    const cr = new ClientReceiver(logger.createSubLogger('cr'), {
      onRetrieve: <T extends MXDBRecord>(request: MXDBRecordStatesRequest): MXDBRecordStates<T> => {
        const out: MXDBRecordStates<T> = [];
        for (const item of request) {
          const states = db.use<T>(item.collectionName).getStatesSync(item.recordIds);
          if (states.length > 0) out.push({ collectionName: item.collectionName, records: states });
        }
        return out;
      },
      onUpdate: (updates: MXDBUpdateRequest): MXDBSyncEngineResponse => {
        const response: MXDBSyncEngineResponse = [];
        for (const item of updates) {
          let collection: ReturnType<typeof db.use>;
          try { collection = db.use(item.collectionName); }
          catch { continue; }
          const successfulRecordIds: string[] = [];
          for (const rec of item.records ?? []) {
            collection.applyServerWriteSync(rec.record, rec.lastAuditEntryId);
            successfulRecordIds.push(rec.record.id);
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
    });
    return { cr, c2s };
  }, []);

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

  useEffect(() => {
    if (getIsConnected()) {
      void c2s.start().catch(error => onError?.({
        code: 'SYNC_FAILED',
        message: error instanceof Error ? error.message : String(error),
        severity: 'error',
        originalError: error,
      }));
    }
  }, []);

  useOnUnmount(() => {
    c2s.close();
  });

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
