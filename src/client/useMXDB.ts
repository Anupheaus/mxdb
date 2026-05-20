import { useContext, useMemo, useRef, useState } from 'react';
import { is } from '@anupheaus/common';
import { useNexus } from '@anupheaus/nexus/client';
import { useSyncState } from './providers/client-to-server/SyncStateContext';
import { DbsContext } from './providers/dbs/DbContext';

export function useMXDB() {
  const { getIsConnected, onConnectionStateChanged, getSocket, disconnect, connect } = useNexus();
  const [isConnected, setIsConnected] = useState(useMemo(() => getIsConnected(), []));
  const { isSyncing, onSyncStateChanged } = useSyncState();
  const updateWhenChangedRef = useRef(false);
  const [clientId, setClientId] = useState(() => getIsConnected() ? getSocket()?.id : undefined);
  const updateWhenSyncChangedRef = useRef(false);
  const [isSyncingState, setIsSyncingState] = useState(isSyncing);
  const { dbs, lastDb } = useContext(DbsContext);

  onConnectionStateChanged((newIsConnected, socket) => {
    if (!updateWhenChangedRef.current) return;
    setClientId(socket?.id);
    setIsConnected(newIsConnected);
  });

  return {
    get isSynchronising() {
      if (!updateWhenSyncChangedRef.current) {
        updateWhenSyncChangedRef.current = true;
        onSyncStateChanged(setIsSyncingState);
      }
      return isSyncingState;
    },
    get isConnected() { updateWhenChangedRef.current = true; return isConnected; },
    get clientId() { updateWhenChangedRef.current = true; return clientId; },
    get isDbReady() { return !is.empty(lastDb) && dbs.has(lastDb); },
    onConnectionStateChanged,
    disconnect,
    connect,
  };
}
