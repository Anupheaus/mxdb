// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import type { ReactNode, MutableRefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type PrfHandler = (userId: string, prfOutput: ArrayBuffer, accountId?: string) => void | Promise<void>;

interface NexusProps {
  host?: string;
  onPrf?: PrfHandler;
  onSignedIn?: (user: unknown) => void;
  children?: ReactNode;
}

interface InnerProps {
  authMode: string;
  onPrfRef: MutableRefObject<PrfHandler | undefined>;
  children?: ReactNode;
}

const captured = vi.hoisted(() => ({ nexus: undefined as NexusProps | undefined, inner: undefined as InnerProps | undefined }));

vi.mock('@anupheaus/nexus/client', () => ({
  Nexus: (props: NexusProps) => { captured.nexus = props; return props.children; },
}));

vi.mock('./auth/MXDBSyncInner', () => ({
  MXDBSyncInner: (props: InnerProps) => { captured.inner = props; return props.children; },
}));

vi.mock('@anupheaus/react-ui', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createComponent: (_name: string, component: unknown) => component,
  LoggerProvider: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock('./utils/setupBrowserTools', () => ({ setupBrowserTools: vi.fn() }));

const { MXDBSync } = await import('./MXDBSync');

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;

async function render(props: Partial<React.ComponentProps<typeof MXDBSync>> = {}) {
  await act(async () => {
    root.render(<MXDBSync name="my-app" collections={[]} {...props}><span>child</span></MXDBSync>);
  });
}

beforeEach(() => {
  captured.nexus = undefined;
  captured.inner = undefined;
  root = createRoot(document.createElement('div'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined); // React logs render errors
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  vi.restoreAllMocks();
});

describe('MXDBSync — host validation', () => {
  const insecureHosts = ['http://api.example.com', 'ws://api.example.com', 'https://api.example.com', 'HTTP://api.example.com', 'ftp://api.example.com'];
  const allowedHosts = [undefined, 'wss://api.example.com', 'WSS://api.example.com', 'api.example.com', 'api.example.com:443'];

  it.each(insecureHosts)('refuses to connect to insecure host %s', async host => {
    await expect(render({ host })).rejects.toThrow(`MXDBSync: connection to "${host}" uses an insecure protocol. Only wss:// is allowed.`);
  });

  it.each(allowedHosts)('connects to host %s', async host => {
    await render({ host });
    expect(captured.nexus?.host).toBe(host);
  });
});

describe('MXDBSync — auth wiring', () => {
  it('defaults to webauthn and forwards passkey PRF output to the inner sync layer', async () => {
    await render();
    const handler = vi.fn();
    captured.inner!.onPrfRef.current = handler;
    const prfOutput = new ArrayBuffer(32);

    await captured.nexus!.onPrf!('alice', prfOutput, 'acme');

    expect(captured.inner?.authMode).toBe('webauthn');
    expect(handler).toHaveBeenCalledWith('alice', prfOutput, 'acme');
  });

  it('tolerates PRF output arriving before the inner sync layer is ready', async () => {
    await render();
    captured.inner!.onPrfRef.current = undefined;

    expect(() => captured.nexus!.onPrf!('alice', new ArrayBuffer(32))).not.toThrow();
  });

  it('does not request passkey PRF output in google-oauth mode', async () => {
    await render({ authMode: 'google-oauth' });

    expect(captured.nexus?.onPrf).toBeUndefined();
    expect(captured.inner?.authMode).toBe('google-oauth');
  });

  it('forwards sign-in notifications to the host app', async () => {
    const onSignedIn = vi.fn();
    await render({ onSignedIn });

    captured.nexus!.onSignedIn!({ id: 'alice' });

    expect(onSignedIn).toHaveBeenCalledWith({ id: 'alice' });
  });

  it('does not subscribe to sign-in notifications when the host app has no onSignedIn', async () => {
    await render();
    expect(captured.nexus?.onSignedIn).toBeUndefined();
  });
});
