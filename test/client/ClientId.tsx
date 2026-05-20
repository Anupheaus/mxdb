import { Button, createComponent, Flex } from '@anupheaus/react-ui';
import { useMXDB, useMXDBSignOut } from '../../src/client';
import { useAuthentication } from '@anupheaus/nexus/client';

export const ClientId = createComponent('ClientId', () => {
  const { clientId } = useMXDB();
  const { user } = useAuthentication();
  const signOut = useMXDBSignOut();

  return <Flex isVertical disableGrow>
    <Flex disableGrow>Client ID:&nbsp;{clientId}</Flex>
    <Flex disableGrow valign="center">User ID:&nbsp;{user?.id}&nbsp;<Button onClick={signOut}>Sign Out</Button></Flex>
  </Flex>;
});