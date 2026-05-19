import { createComponent, useBound } from '@anupheaus/react-ui';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import type { Logger } from '@anupheaus/common';
import { LoggerProvider } from '@anupheaus/react-ui';
import type { SocketAPIUser, TokenStorage } from '@anupheaus/socket-api/client';
import { SocketAPI } from '@anupheaus/socket-api/client';
import { ConflictResolutionContext } from './providers';
import { MXDBSyncInner } from './auth/MXDBSyncInner';
import { setupBrowserTools } from './utils/setupBrowserTools';
import type { MXDBCollection, MXDBError } from '../common';
import type { MXDBUser } from '../common/models';

interface Props {
  host?: string;
  name: string;
  logger?: Logger;
  autoConnect?: boolean;
  collections: MXDBCollection[];
  /** Defaults to `'webauthn'`. Set to `'google-oauth'` when the server uses Google OAuth. */
  authMode?: 'webauthn' | 'google-oauth';
  onDeviceDisabled?(): void;
  onSignedIn?(user: MXDBUser): void;
  onSignedOut?(): void;
  onError?(error: MXDBError): void;
  onConflictResolution?(message: string): Promise<boolean>;
  tokenStorage?: TokenStorage;
  children?: ReactNode;
}

export const MXDBSync = createComponent('MXDBSync', ({
  host,
  name,
  logger,
  autoConnect,
  collections,
  authMode = 'webauthn',
  onDeviceDisabled,
  onSignedIn,
  onSignedOut,
  onError,
  onConflictResolution,
  tokenStorage,
  children,
}: Props) => {
  if (host != null) {
    const protocol = host.match(/^([a-z][a-z0-9+\-.]*:\/\/)/i)?.[1]?.toLowerCase();
    if (protocol != null && protocol !== 'wss://') {
      throw new Error(`MXDBSync: connection to "${host}" uses an insecure protocol. Only wss:// is allowed.`);
    }
  }

  useEffect(() => { setupBrowserTools(name); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const conflictResolutionContext = useMemo(() => ({ onConflictResolution }), [onConflictResolution]);

  const onPrfRef = useRef<
    ((userId: string, prfOutput: ArrayBuffer, accountId?: string) => void | Promise<void>) | undefined
  >(undefined);

  const handlePrf = useBound(
    (userId: string, prfOutput: ArrayBuffer, accountId?: string) =>
      onPrfRef.current?.(userId, prfOutput, accountId) ?? undefined,
  );
  const handleSignedIn = useBound((user: SocketAPIUser) => onSignedIn?.(user as MXDBUser));

  return (
    <LoggerProvider logger={logger} loggerName="MXDB">
      <ConflictResolutionContext.Provider value={conflictResolutionContext}>
        <SocketAPI
          name={name}
          host={host}
          autoConnect={autoConnect}
          onPrf={authMode === 'webauthn' ? handlePrf : undefined}
          onDeviceDisabled={onDeviceDisabled}
          onSignedIn={onSignedIn != null ? handleSignedIn : undefined}
          onSignedOut={onSignedOut}
          tokenStorage={tokenStorage}
        >
          <MXDBSyncInner
            appName={name}
            authMode={authMode}
            collections={collections}
            onPrfRef={onPrfRef}
            onError={onError}
            onSignedIn={onSignedIn}
            onSignedOut={onSignedOut}
          >
            {children}
          </MXDBSyncInner>
        </SocketAPI>
      </ConflictResolutionContext.Provider>
    </LoggerProvider>
  );
});
