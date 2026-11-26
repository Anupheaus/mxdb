import { createComponent, useBound } from '@anupheaus/react-ui';
import type { ReactNode } from 'react';
import { useContext, useEffect, useMemo } from 'react';
import type { Logger } from '@anupheaus/common';
import { dbs } from './Dbs';
import { configRegistry } from '../../../common';
import type { MXDBCollection, MXDBError } from '../../../common';
import type { DbsContextProps } from './DbContext';
import { createNewDbContext, DbsContext } from './DbContext';

interface Props {
  name: string;
  logger?: Logger;
  collections: MXDBCollection[];
  /** Raw 256-bit AES-GCM key bytes from WebAuthn PRF. Omit for unencrypted. */
  encryptionKey?: Uint8Array;
  /** Told, as `DB_NOT_OPEN` (fatal), when the database could not be opened — e.g. its SQLite worker never started. */
  onError?(error: MXDBError): void;
  children?: ReactNode;
}

export const DbsProvider = createComponent('DbsProvider', ({
  name,
  collections,
  encryptionKey,
  logger,
  onError,
  children = null,
}: Props) => {
  const existingContext = useContext(DbsContext);

  const { context, db } = useMemo(() => {
    if (encryptionKey == null) {
      throw new Error('MXDB: DbsProvider requires an encryptionKey — unencrypted local storage is not permitted. Derive a key via WebAuthn PRF (deriveEncryptionKey) before opening the database.');
    }
    // [LOCK-DIAG] This useMemo re-running is what drives the close→reopen churn. Logging the deps'
    // identities tells us WHICH dep changed on reconnect (encryptionKey is the prime suspect — a
    // fresh Uint8Array is produced on every re-auth).
    console.warn('[LOCK-DIAG] DbsProvider useMemo RE-RUN (close→open)', { t: Date.now(), name, collectionsCount: collections.length }); // [LOCK-DIAG]
    dbs.close(name);
    const configurations = collections.map(collection => configRegistry.getOrError(collection));
    const openedDb = dbs.open(name, configurations, encryptionKey, logger);
    const dbContext: DbsContextProps = createNewDbContext(existingContext, openedDb, collections);
    return { context: dbContext, db: openedDb };
  }, [existingContext, name, collections, encryptionKey, logger]);

  const reportOpenFailure = useBound((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error('The local database could not be opened', { name, error: message });
    onError?.({ code: 'DB_NOT_OPEN', severity: 'fatal', message, originalError: error });
  });

  // Every read and write waits for the open, so a failed open would otherwise leave the app waiting for ever.
  useEffect(() => {
    let isCurrent = true;
    db.whenOpen().catch(error => {
      // A database replaced meanwhile (new key, sign-out) is no longer the app's concern.
      if (isCurrent) reportOpenFailure(error);
    });
    return () => { isCurrent = false; };
  }, [db]);

  return (
    <DbsContext.Provider value={context}>
      {children}
    </DbsContext.Provider>
  );
});
