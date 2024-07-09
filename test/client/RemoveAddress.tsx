import { Button, Flex, createComponent, useBound } from '@anupheaus/react-ui';
import { address, officeAddress } from './collections';
import { useCollection } from '../../src';

export const RemoveAddress = createComponent('RemoveAddress', () => {
  const { remove } = useCollection(address);

  const removeAddress = useBound(() => {
    remove(officeAddress);
  });

  return (
    <Flex tagName="remove-address">
      <Button onClick={removeAddress}>Remove Address</Button>
    </Flex>
  );
});