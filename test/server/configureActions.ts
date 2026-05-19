import { createServerActionHandler, useAuthentication, type SocketAPIServerAction } from '@anupheaus/nexus/server';
import { signInAction, testAction } from '../common';

export const actions: SocketAPIServerAction[] = [
  createServerActionHandler(testAction, async ({ foo }) => {
    return { bar: foo };
  }),
  createServerActionHandler(signInAction, async () => {
    const { setUser } = useAuthentication();
    void setUser({ id: Math.uniqueId() });
    return true;
  }),
];
