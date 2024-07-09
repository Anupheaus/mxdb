import { createComponent } from '@anupheaus/react-ui';
import { ReactNode, useLayoutEffect, useState } from 'react';
import { useCollection } from '../../src';
import { address, allAddresses } from './collections';

interface Props {
  shouldSeed?: boolean;
  children?: ReactNode;
}

export const SeedAddresses = createComponent('SeedAddresses', ({
  shouldSeed = false,
  children,
}: Props) => {
  const [showChildren, setShowChildren] = useState(!shouldSeed);
  const { upsert } = useCollection(address);

  useLayoutEffect(() => {
    if (!shouldSeed) return;
    (async () => {
      await upsert(allAddresses);
      setShowChildren(true);
    })();
  }, []);

  if (!showChildren) return null;

  return (<>
    {children}
  </>);
});
