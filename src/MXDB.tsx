import { LoggerProvider, createComponent } from '@anupheaus/react-ui';
import { ReactNode, useLayoutEffect, useState } from 'react';
import { MXDBCollection } from './models';
import { DbContext, DbContextProps, createDbContext } from './DbContext';
import { Logger } from '@anupheaus/common';
import { InternalDbContext } from './internalModels';

interface Props {
  name: string;
  collections: MXDBCollection[];
  children?: ReactNode;
}

const logger = new Logger('MXDB');

export const MXDB = createComponent('MXDB', ({
  name,
  collections,
  children = null,
}: Props) => {

  const [context, setContext] = useState<DbContextProps>();

  useLayoutEffect(() => {
    (async () => setContext(await createDbContext(name, collections, logger)))();
  }, [name, collections]);

  if (context == null) return null;

  (window as any)[InternalDbContext] = context.db;

  return (
    <LoggerProvider logger={logger}>
      <DbContext.Provider value={context}>
        {children}
      </DbContext.Provider>
    </LoggerProvider>
  );
});
