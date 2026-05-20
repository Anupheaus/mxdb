import { createComponent, useLogger } from '@anupheaus/react-ui';
import { useServerActionHandler } from '@anupheaus/nexus/client';
import { mxdbServerToClientSyncAction } from '../../../common';
import { SyncPausedError, type MXDBSyncEngineResponse } from '../../../common/sync-engine';
import { useClientReceiver } from './ClientReceiverContext';

/**
 * Owns the S2C Socket.IO handler. Delegates payload processing directly to the
 * {@link ClientReceiver} provided by {@link ClientToServerSyncProvider}.
 *
 * The CR is pause/resume-d by the CD around every C2S dispatch; the handler
 * surfaces {@link SyncPausedError} back to the server by returning an empty
 * response (the SD will retry shortly).
 */
export const ServerToClientProvider = createComponent('ServerToClientProvider', () => {
  const logger = useLogger('s2c');
  const cr = useClientReceiver();

  useServerActionHandler(mxdbServerToClientSyncAction)(async payload => {
    if (cr == null) {
      logger.warn('S2C payload received before ClientReceiver is available — dropping');
      return [] as MXDBSyncEngineResponse;
    }
    try {
      return cr.process(payload);
    } catch (error) {
      if (error instanceof SyncPausedError) {
        // Re-throw as a transport-visible error: the server-side SD wrapper detects
        // this sentinel message and rethrows a local SyncPausedError so the SD
        // switches to its retry timer instead of rejecting the dispatch entirely.
        throw new Error('MXDB_SYNC_PAUSED');
      }
      logger.error('S2C process failed', { error: error as Record<string, unknown> });
      throw error;
    }
  });

  return null;
});
