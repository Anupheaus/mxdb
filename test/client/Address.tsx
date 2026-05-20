import { createComponent } from '@anupheaus/react-ui';
import { useCollection } from '../../src/client';
import { useAction } from '@anupheaus/nexus/client';
import { addresses, testAction } from '../common';

interface Props {
  id: string;
}

export const Address = createComponent('Address', ({
  id,
}: Props) => {
  const { useTest } = useAction(testAction);
  const { useGet } = useCollection(addresses);
  const { record: address } = useGet(id);
  const { response, isLoading, error } = useTest({ foo: 'hey' });

  console.log('address render', { response: response?.bar, isLoading, error });

  return (<>
    <div>{address?.firstLine}</div>
    <div>{address?.secondLine}</div>
    <div>{address?.city}</div>
    <div>{address?.county}</div>
    <div>{address?.postcode}</div>
  </>);
});