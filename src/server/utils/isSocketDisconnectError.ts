/** Messages socket.io uses when an emit/ack is abandoned because the client's connection went away. */
const SOCKET_DISCONNECT_MESSAGE_PATTERN = /socket has been disconnected|transport close/i;

/**
 * Detects the rejection socket.io raises when pushing to a client whose socket has
 * already gone (the client left, or the server is restarting / tearing down).
 *
 * This is expected and not a correctness failure — the client re-syncs on reconnect —
 * so callers should log it quietly (debug) rather than as an error.
 */
export function isSocketDisconnectError(error: unknown): boolean {
  const message = typeof error === 'string' ? error : (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && SOCKET_DISCONNECT_MESSAGE_PATTERN.test(message);
}
