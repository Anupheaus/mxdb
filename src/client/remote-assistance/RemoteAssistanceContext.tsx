import { createContext, useContext } from 'react';
import type { MXDBRemoteAssistanceConfig } from './models';

export const RemoteAssistanceContext = createContext<MXDBRemoteAssistanceConfig | undefined>(undefined);

export function useRemoteAssistanceConfig(): MXDBRemoteAssistanceConfig | undefined {
  return useContext(RemoteAssistanceContext);
}

