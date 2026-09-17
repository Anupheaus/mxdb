import { useLogger } from '@anupheaus/common';
import { setDb, setServerToClientSync } from './DbContext';
import { ServerDb } from './ServerDb';
import type { MXDBCollection } from '../../../common';
import { ServerToClientSynchronisation } from '../../ServerToClientSynchronisation';

export interface ProvideDbOptions {
  changeStreamDebounceMs?: number;
  watch?: boolean;
}

export function provideDb<R>(
  mongoDbName: string,
  mongoDbUrl: string,
  collections: MXDBCollection[],
  delegate: (db: ServerDb) => R,
  options?: ProvideDbOptions,
): R {
  const logger = useLogger();
  const { changeStreamDebounceMs, watch } = options ?? {};

  const db = new ServerDb({
    mongoDbName,
    mongoDbUrl,
    collections,
    logger,
    changeStreamDebounceMs,
    watch,
  });

  setDb(db);
  setServerToClientSync(ServerToClientSynchronisation.createNoOp(collections, logger.createSubLogger('s2c:noop')));
  return delegate(db);
}
