import { createComponent, useLogger } from '@anupheaus/react-ui';
import type { ReactNode, MutableRefObject } from 'react';
import { useState, useEffect, useRef } from 'react';
import { useAuthentication } from '@anupheaus/socket-api/client';
import { DbsProvider } from '../providers/dbs';
import { ClientToServerSyncProvider, ClientToServerProvider } from '../providers/client-to-server';
import { ServerToClientProvider } from '../providers/server-to-client';
import { deriveKey } from './deriveKey';
import { saveEncryptionToSession, loadEncryptionFromSession, clearEncryptionFromSession } from './encryptionSessionCache';
import type { MXDBCollection, MXDBError } from '../../common';
import type { MXDBAccount, MXDBUser } from '../../common/models';

interface Props {
  appName: string;
  authMode: 'webauthn' | 'google-oauth';
  collections: MXDBCollection[];
  onPrfRef: MutableRefObject<
    ((userId: string, prfOutput: ArrayBuffer, accountId?: string) => void | Promise<void>) | undefined
  >;
  onError?(error: MXDBError): void;
  onSignedIn?(user: MXDBUser): void;
  onSignedOut?(): void;
  children?: ReactNode;
}

// Google OAuth has no hardware-backed PRF so local data is unencrypted at rest.
// All-zero key distinguishes this from the dev-bypass pattern (0xde).
const GOOGLE_OAUTH_PLACEHOLDER_KEY = new Uint8Array(32).fill(0);

export const MXDBSyncInner = createComponent('MXDBSyncInner', ({
  appName,
  authMode,
  collections,
  onPrfRef,
  onError,
  onSignedIn,
  onSignedOut,
  children,
}: Props) => {
  const logger = useLogger('MXDBSyncInner');
  const { user } = useAuthentication<MXDBUser, MXDBAccount>();
  const [encryptionKey, setEncryptionKey] = useState<Uint8Array | undefined>();
  const [dbName, setDbName] = useState<string | undefined>();
  const channelRef = useRef<BroadcastChannel | null>(null);
  const prevUserRef = useRef<MXDBUser | undefined>(undefined);
  const reauthInProgressRef = useRef(false);

  // Dev bypass (non-production only)
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const devJson =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(`mxdb:dev-auth:${appName}`)
        : null;
    if (devJson == null) return;
    try {
      const { userId } = JSON.parse(devJson) as { userId: string };
      logger.info('[dev] dev bypass auth');
      localStorage.removeItem(`mxdb:dev-auth:${appName}`);
      setDbName(userId);
      setEncryptionKey(new Uint8Array(32).fill(0xde));
    } catch {
      localStorage.removeItem(`mxdb:dev-auth:${appName}`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // BroadcastChannel: cross-tab sign-out
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(`mxdb-auth-${appName}`);
    channelRef.current = channel;
    channel.onmessage = ({ data }: MessageEvent<{ type: string; userId?: string }>) => {
      if (data?.type === 'signed-out') {
        if (data.userId) clearEncryptionFromSession(appName, data.userId);
        setEncryptionKey(undefined);
        setDbName(undefined);
      }
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [appName]);

  // WebAuthn only: wire the PRF handler — called by socket-api after the passkey ceremony
  useEffect(() => {
    if (authMode !== 'webauthn') return;
    onPrfRef.current = async (userId: string, prfOutput: ArrayBuffer, accountId?: string) => {
      try {
        const key = await deriveKey(prfOutput);
        const dbName = accountId ?? userId;
        // Cache the derived key so page refreshes can restore it from session without a
        // new WebAuthn ceremony (session cookie handles re-auth; PRF handles encryption).
        saveEncryptionToSession(appName, userId, key, dbName);
        setEncryptionKey(key);
        setDbName(dbName);
        reauthInProgressRef.current = false;
      } catch (err) {
        reauthInProgressRef.current = false;
        onError?.({
          code: 'ENCRYPTION_FAILED',
          message: err instanceof Error ? err.message : 'Key derivation failed',
          severity: 'fatal',
          originalError: err,
        });
      }
    };
    return () => {
      onPrfRef.current = undefined;
    };
  }, [authMode, onPrfRef, onError, appName]);

  // React to user state changes
  useEffect(() => {
    const prev = prevUserRef.current;
    prevUserRef.current = user;

    if (user == null && prev != null) {
      clearEncryptionFromSession(appName, prev.id);
      setEncryptionKey(undefined);
      setDbName(undefined);
      channelRef.current?.postMessage({ type: 'signed-out', userId: prev.id });
      onSignedOut?.();
      return;
    }

    if (user != null && prev == null) {
      onSignedIn?.(user);
      if (authMode === 'google-oauth') {
        // Google OAuth: no PRF ceremony — mount DbsProvider immediately on sign-in
        setDbName(user.id);
        setEncryptionKey(GOOGLE_OAUTH_PLACEHOLDER_KEY);
      } else {
        // WebAuthn: restore the PRF-derived encryption key from session cache so a page
        // refresh doesn't require a new passkey ceremony (session cookie handles re-auth).
        const cached = loadEncryptionFromSession(appName, user.id);
        if (cached != null) {
          setEncryptionKey(cached.key);
          setDbName(cached.dbName);
        }
        // No cached key → wait for the WebAuthn PRF ceremony via DeviceAuthGate/signIn
      }
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  if (encryptionKey == null || dbName == null) {
    return <>{children}</>;
  }

  return (
    <DbsProvider name={dbName} encryptionKey={encryptionKey} collections={collections} logger={logger}>
      <ClientToServerSyncProvider collections={collections} onError={onError}>
        <ClientToServerProvider />
        <ServerToClientProvider />
        {children}
      </ClientToServerSyncProvider>
    </DbsProvider>
  );
});
