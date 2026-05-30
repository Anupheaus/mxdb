import type { MXDBCollection } from '../common';
import { Logger, is } from '@anupheaus/common';
import { useDb } from './providers';
import type { ServerToClientSynchronisation } from './ServerToClientSynchronisation';
import type { Socket } from 'socket.io';
import type { Unsubscribe } from '@anupheaus/common';
import type { ServerDbChangeEvent } from './providers/db/server-db-models';

const clientWatchSubscriptions = new WeakMap<Socket, Unsubscribe>();

/**
 * Feed MongoDB change-stream events into the per-connection
 * {@link ServerToClientSynchronisation}. The wrapper forwards events to the
 * underlying {@link ServerDispatcher}, which handles filter bookkeeping,
 * retry, and delivery.
 *
 * Tombstone filtering happens inside `s2c.onDbChange`, not here.
 * This function passes all change events through verbatim; the S2C wrapper
 * consults the auditor to drop any upserts whose audit shows a tombstoned
 * record so that resurrection pushes never reach SD/CR.
 */
export function addClientWatches(
  client: Socket,
  collections: MXDBCollection[],
  s2c: ServerToClientSynchronisation,
): void {
  const db = useDb();
  if (clientWatchSubscriptions.has(client)) return;

  clientWatchSubscriptions.set(client, db.onChange(async (event: ServerDbChangeEvent) => {
    const collection = collections.findBy('name', event.collectionName);
    if (collection == null) return;
    const watchLog = !is.browser() ? Logger.getCurrent()?.createSubLogger('clientDbWatches') : undefined;

    try {
      switch (event.type) {
        case 'insert':
        case 'update': {
          await s2c.onDbChange({ type: 'upsert', collectionName: event.collectionName, records: event.records });
          break;
        }
        case 'delete': {
          await s2c.onDbChange({ type: 'delete', collectionName: event.collectionName, recordIds: event.recordIds });
          break;
        }
      }
    } catch (error) {
      watchLog?.error('changeStream → S2C dispatch failed', {
        collectionName: event.collectionName,
        error: error as Record<string, unknown>,
      });
    }
  }));
}

export function removeClientWatches(client: Socket): void {
  const unsubscription = clientWatchSubscriptions.get(client);
  if (unsubscription == null) return;
  unsubscription();
  clientWatchSubscriptions.delete(client);
}
