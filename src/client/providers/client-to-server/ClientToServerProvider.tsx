import { createComponent } from '@anupheaus/react-ui';
import { useDb } from '../dbs';
import { useLayoutEffect } from 'react';
import { useClientToServerSyncInstance } from './useClientToServerSyncInstance';

/**
 * Subscribes to every configured collection's onChange stream and forwards
 * client-originated upserts and removes to the {@link ClientToServerSynchronisation}
 * wrapper. Branched upserts (server-driven) and `auditAction === 'remove'` removes
 * (server-driven reconciliation) are excluded.
 *
 * Re-subscribes whenever the Db or sync instance changes: DbsProvider swaps the Db when the encryption
 * key changes, and ClientToServerSyncProvider rebuilds the sync instance with it — subscriptions kept on
 * the replaced Db would miss every later local mutation.
 */
export const ClientToServerProvider = createComponent('ClientToServerProvider', () => {
  const { db, collections } = useDb();
  const c2s = useClientToServerSyncInstance();

  useLayoutEffect(() => {
    if (c2s == null) return;

    const unsubscribes = collections.map(collection => db.use(collection.name).onChange(event => {
      switch (event.type) {
        case 'upsert': {
          if (event.auditAction === 'branched') return;
          for (const record of event.records) c2s.enqueue(collection.name, record.id);
          break;
        }
        case 'remove': {
          if (event.auditAction === 'remove') return;
          for (const id of event.ids) c2s.enqueue(collection.name, id);
          break;
        }
        // 'clear' and 'reload' events are not client-originated mutations → no enqueue
      }
    }));
    return () => unsubscribes.forEach(unsubscribe => unsubscribe());
  }, [db, c2s, collections]);

  return null;
});
