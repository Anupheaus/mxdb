import { Button, Flex, createComponent, useBound } from '@anupheaus/react-ui';
import { useCollection } from '../../src';
import { address, officeAddress } from './collections';

export const AddAddress = createComponent('AddAddress', () => {
  const { upsert } = useCollection(address);
  const addAddress = useBound(() => {
    upsert(officeAddress);
  });

  return (
    <Flex tagName="add-address">
      <Button onClick={addAddress}>Add Address</Button>
    </Flex>
  );
});