import { createComponent } from '@anupheaus/react-ui';
import { MXDB } from '../../src';
import { address } from './collections';
import { Address } from './Address';
import { AddAddress } from './AddAddress';
import { RemoveAddress } from './RemoveAddress';

const collections = [
  address,
];

export const App = createComponent('App', () => {
  return (
    <MXDB name="test" collections={collections}>
      <AddAddress />
      <RemoveAddress />
      <Address />
    </MXDB>
  );
});