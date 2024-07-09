import { Flex, Typography, UIState, createComponent } from '@anupheaus/react-ui';
import { useCollection } from '../../src';
import { address } from './collections';

export const Address = createComponent('Address', () => {
  const { useQuery } = useCollection(address);
  // const { record: addr, isLoading } = useGet(officeAddress.id);
  const { records: addresses, isLoading } = useQuery({ filter: { firstLine: { $ne: 'boo' } }, sort: { field: 'firstLine', direction: 'asc' }, pagination: { limit: 10 } });

  return (
    <UIState isLoading={isLoading}>
      <Flex tagName="address">
        <Typography>
          {addresses?.[0]?.firstLine}
        </Typography>
      </Flex>
    </UIState>
  );
});