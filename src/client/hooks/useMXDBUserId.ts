import { useAuthentication } from '@anupheaus/nexus/client';

export function useMXDBUserId(): string | undefined {
  return useAuthentication().user?.id;
}
