/**
 * In-worker TLS trust for the e2e wss:// server (self-signed cert). Runs as a Vitest setupFile — before
 * the test module imports socket.io-client and long before any socket connects — so it replaces the
 * former `NODE_OPTIONS=--require=preload-tls.cjs` preload without forcing a `--require`, which interfered
 * with vite-node's module transform in worker processes. `NODE_EXTRA_CA_CERTS` (set via test.env) trusts
 * the CA; this additionally defaults rejectUnauthorized=false as belt-and-suspenders for the self-signed cert.
 */
import tls from 'node:tls';

type ConnectArgs = Parameters<typeof tls.connect>;
const originalConnect = tls.connect.bind(tls);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tls.connect has many overloads
(tls as any).connect = (...args: ConnectArgs) => {
  const last = args[args.length - 1] as { rejectUnauthorized?: boolean } | undefined;
  if (last != null && typeof last === 'object' && !Array.isArray(last) && last.rejectUnauthorized === undefined) {
    last.rejectUnauthorized = false;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forwarding original overloaded call
  return (originalConnect as any)(...args);
};
