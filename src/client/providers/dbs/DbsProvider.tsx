import { createComponent } from '@anupheaus/react-ui';
import type { ReactNode } from 'react';
import { useContext, useMemo } from 'react';
import type { Logger } from '@anupheaus/common';
import { dbs } from './Dbs';
import { configRegistry } from '../../../common';
import type { MXDBCollection } from '../../../common';
import type { DbsContextProps } from './DbContext';
import { createNewDbContext, DbsContext } from './DbContext';

interface Props {
  name: string;
  logger?: Logger;
  collections: MXDBCollection[];
  /** Raw 256-bit AES-GCM key bytes from WebAuthn PRF. Omit for unencrypted. */
  encryptionKey?: Uint8Array;
  children?: ReactNode;
}

export const DbsProvider = createComponent('DbsProvider', ({
  name,
  collections,
  encryptionKey,
  logger,
  children = null,
}: Props) => {
  const existingContext = useContext(DbsContext);

  const context = useMemo<DbsContextProps>(() => {
    if (encryptionKey == null) {
      throw new Error('MXDB: DbsProvider requires an encryptionKey — unencrypted local storage is not permitted. Derive a key via WebAuthn PRF (deriveEncryptionKey) before opening the database.');
    }
    // [LOCK-DIAG] This useMemo re-running is what drives the close→reopen churn. Logging the deps'
    // identities tells us WHICH dep changed on reconnect (encryptionKey is the prime suspect — a
    // fresh Uint8Array is produced on every re-auth).
    console.warn('[LOCK-DIAG] DbsProvider useMemo RE-RUN (close→open)', { t: Date.now(), name, collectionsCount: collections.length }); // [LOCK-DIAG]
    dbs.close(name);
    const configurations = collections.map(collection => configRegistry.getOrError(collection));
    const db = dbs.open(name, configurations, encryptionKey, logger);
    return createNewDbContext(existingContext, db, collections);
  }, [existingContext, name, collections, encryptionKey, logger]);

  return (
    <DbsContext.Provider value={context}>
      {children}
    </DbsContext.Provider>
  );
});
