import { useAuthentication } from '@anupheaus/nexus/client';

export function useMXDBSignOut(): () => Promise<void> {
  return useAuthentication().signOut;
}
