import type { Unsubscribe, Record, Logger } from '@anupheaus/common';
import { is } from '@anupheaus/common';
import type { MXDBCollection, MXDBOnChangeEvent } from '../../common';
import type { ServerDb, ServerDbCollection } from '../providers';
import { useDb } from '../providers';
import { useLogger } from '@anupheaus/nexus/server';

const subscriptionIds = new Map<string, Unsubscribe>();

function createOnChange(db: ServerDb, dbCollection: ServerDbCollection<any>, logger: Logger) {
  function onChange(subscriptionId: string, callback: (record: MXDBOnChangeEvent) => void): void;
  function onChange(callback: (record: MXDBOnChangeEvent) => void): Unsubscribe;
  function onChange(subscriptionIdOrCallback: string | ((record: MXDBOnChangeEvent) => void), callback?: (record: MXDBOnChangeEvent) => void) {
    callback = is.function(subscriptionIdOrCallback) ? subscriptionIdOrCallback : callback;
    const subscriptionId = is.not.blank(subscriptionIdOrCallback) ? subscriptionIdOrCallback : undefined;
    if (callback == null) throw new Error('Callback is required to subscribe to changes for this collection');
    const userCallback = callback;
    const unsubscribe = db.onChange(event => {
      if (event.collectionName !== dbCollection.name) return;
      // Catch floating promise rejections from async callbacks (e.g.
      // subscription onChange handlers that fire after the client socket has
      // disconnected during a server restart / teardown). Without this guard,
      // the rejection surfaces as an unhandled promise rejection in the
      // Vitest runner because nobody awaits the callback's return value.
      try {
        const result = userCallback(event);
        if (result != null && typeof (result as any).catch === 'function') {
          (result as Promise<unknown>).catch(err => {
            const msg = (err as any)?.message ?? String(err);
            if (/socket has been disconnected|transport close/i.test(msg)) {
              logger.debug('onChange callback rejected (socket disconnected — expected during teardown)', {
                collectionName: dbCollection.name, subscriptionId, error: msg,
              });
            } else {
              logger.error('onChange callback rejected', {
                collectionName: dbCollection.name, subscriptionId, error: msg,
              });
            }
          });
        }
      } catch (err) {
        logger.error('onChange callback threw synchronously', {
          collectionName: dbCollection.name, subscriptionId, error: (err as any)?.message ?? String(err),
        });
      }
    });
    if (subscriptionId != null) subscriptionIds.set(subscriptionId, unsubscribe);
    return unsubscribe;
  }

  return onChange;
}

function useTypedCollection<RecordType extends Record>(db: ServerDb, dbCollection: ServerDbCollection<RecordType>, logger: Logger) {
  return {
    collection: dbCollection.collection,
    get: dbCollection.get,
    getAudit: dbCollection.getAudit,
    query: dbCollection.query,
    find: dbCollection.find,
    upsert: dbCollection.upsert,
    remove: dbCollection.remove,
    distinct: dbCollection.distinct,
    clear: dbCollection.clear,
    getRecordCount: dbCollection.count,
    getAll: dbCollection.getAll,
    sync: dbCollection.sync,
    onChange: createOnChange(db, dbCollection, logger),
    removeOnChange: (subscriptionId: string) => {
      const unsubscribe = subscriptionIds.get(subscriptionId);
      if (unsubscribe == null) return;
      unsubscribe();
      subscriptionIds.delete(subscriptionId);
    },
  };
}

export type UseCollection<RecordType extends Record> = ReturnType<typeof useTypedCollection<RecordType>>;

export function useCollection<RecordType extends Record>(collection: MXDBCollection<RecordType>): UseCollection<RecordType>;
export function useCollection<RecordType extends Record = Record>(collectionName: string): UseCollection<RecordType>;
export function useCollection<RecordType extends Record>(collectionOrName: MXDBCollection<RecordType> | string): UseCollection<RecordType> {
  const db = useDb();
  const logger = useLogger();
  const collection = db.use<RecordType>(is.string(collectionOrName) ? collectionOrName : collectionOrName.name);
  return useTypedCollection<RecordType>(db, collection, logger);
}
