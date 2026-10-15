import { createComponent, useBound } from '@anupheaus/react-ui';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import type { Logger } from '@anupheaus/common';
import { LoggerProvider } from '@anupheaus/react-ui';
import type { NexusUser, TokenStorage } from '@anupheaus/nexus/client';
import { Nexus } from '@anupheaus/nexus/client';
import { ConflictResolutionContext } from './providers';
import { MXDBSyncInner } from './auth/MXDBSyncInner';
import { setupBrowserTools } from './utils/setupBrowserTools';
import type { MXDBCollection, MXDBError, MXDBSyncAmendment, MXDBSyncRejection } from '../common';
import type { MXDBUser } from '../common/models';
import type { MXDBRemoteAssistanceConfig } from './remote-assistance/models';

interface Props {
  host?: string;
  name: string;
  logger?: Logger;
  autoConnect?: boolean;
  collections: MXDBCollection[];
  remoteAssistance?: MXDBRemoteAssistanceConfig;
  /** Defaults to `'webauthn'`. Set to `'google-oauth'` when the server uses Google OAuth. */
  authMode?: 'webauthn' | 'google-oauth';
  onDeviceDisabled?(): void;
  onSignedIn?(user: MXDBUser): void;
  onSignedOut?(): void;
  onError?(error: MXDBError): void;
  /**
   * Called when the server refuses local changes because a collection before-write hook threw. The
   * device has already been brought back in line (see {@link MXDBSyncRejection}); use this to tell the
   * user why their change did not stick.
   */
  onSyncRejected?(rejections: MXDBSyncRejection[]): void;
  /**
   * Called when the server saved a local change but partly amended it: a collection before-write hook put some
   * protected fields back and said why. The amended record has already been pushed to the device (see
   * {@link MXDBSyncAmendment}); use this to tell the user what was put back. One call per sync response.
   */
  onSyncAmended?(amendments: MXDBSyncAmendment[]): void;
  onConflictResolution?(message: string): Promise<boolean>;
  tokenStorage?: TokenStorage;
  /**
   * The WebAuthn relying party (a domain) for passkeys, passed to nexus's `<Nexus rpId>`. Omit it to use the page's own
   * host. A native app sets it: its page must be served from a subdomain of it (Capacitor's `server.hostname`), and
   * `https://<rpId>/.well-known/assetlinks.json` must name the app. Never set a parent domain on the web, where every
   * page under that domain could then use the passkeys.
   */
  rpId?: string;
  children?: ReactNode;
}

export const MXDBSync = createComponent('MXDBSync', ({
  host,
  name,
  logger,
  autoConnect,
  collections,
  remoteAssistance,
  authMode = 'webauthn',
  onDeviceDisabled,
  onSignedIn,
  onSignedOut,
  onError,
  onSyncRejected,
  onSyncAmended,
  onConflictResolution,
  tokenStorage,
  rpId,
  children,
}: Props) => {
  if (host != null) {
    const protocol = host.match(/^([a-z][a-z0-9+\-.]*:\/\/)/i)?.[1]?.toLowerCase();
    if (protocol != null && protocol !== 'wss://') {
      throw new Error(`MXDBSync: connection to "${host}" uses an insecure protocol. Only wss:// is allowed.`);
    }
  }

  useEffect(() => { setupBrowserTools(name); }, []); // mount-only: name is a stable prop

  const conflictResolutionContext = useMemo(() => ({ onConflictResolution }), [onConflictResolution]);

  type OnPrfCallback = ((userId: string, prfOutput: ArrayBuffer, accountId?: string) => void | Promise<void>) | undefined;
  const onPrfRef = useRef<OnPrfCallback>(undefined);

  const handlePrf = useBound(
    (userId: string, prfOutput: ArrayBuffer, accountId?: string) =>
      onPrfRef.current?.(userId, prfOutput, accountId) ?? undefined,
  );
  const handleSignedIn = useBound((user: NexusUser) => onSignedIn?.(user as MXDBUser));

  return (
    <LoggerProvider logger={logger} loggerName="MXDB">
      <ConflictResolutionContext.Provider value={conflictResolutionContext}>
        <Nexus
          name={name}
          host={host}
          autoConnect={autoConnect}
          onPrf={authMode === 'webauthn' ? handlePrf : undefined}
          onDeviceDisabled={onDeviceDisabled}
          onSignedIn={onSignedIn != null ? handleSignedIn : undefined}
          onSignedOut={onSignedOut}
          tokenStorage={tokenStorage}
          rpId={rpId}
        >
          <MXDBSyncInner
            appName={name}
            authMode={authMode}
            collections={collections}
            remoteAssistance={remoteAssistance}
            onPrfRef={onPrfRef}
            onError={onError}
            onSyncRejected={onSyncRejected}
            onSyncAmended={onSyncAmended}
            onSignedIn={onSignedIn}
            onSignedOut={onSignedOut}
          >
            {children}
          </MXDBSyncInner>
        </Nexus>
      </ConflictResolutionContext.Provider>
    </LoggerProvider>
  );
});
