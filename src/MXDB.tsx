import { createComponent } from '@anupheaus/react-ui';
import { ReactNode, useContext, useLayoutEffect, useState } from 'react';
import { MXDBCollection } from './models';
import { DbsContext, DbsContextProps, createDbContext } from './DbContext';
import { InternalError } from '@anupheaus/common';
import { logger, LoggerProvider } from './logger';

interface Props {
  name: string;
  collections: MXDBCollection[];
  children?: ReactNode;
}

export const MXDB = createComponent('MXDB', ({
  name,
  collections,
  children = null,
}: Props) => {
  const existingContext = useContext(DbsContext);
  const [context, setContext] = useState<DbsContextProps>();

  if (existingContext.dbs.has(name)) throw new InternalError(`Database "${name}" already exists in the MXDB contexts.`);

  useLayoutEffect(() => {
    (async () => {
      const db = await createDbContext(name, collections, logger);
      const dbs = new Map(existingContext.dbs);
      dbs.set(name, db);
      setContext({ dbs, lastDb: name });
    })();
  }, [name, collections]);

  if (context == null) return null;

  return (
    <LoggerProvider>
      <DbsContext.Provider value={context}>
        {children}
      </DbsContext.Provider>
    </LoggerProvider>
  );
});
