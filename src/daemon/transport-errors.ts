/**
 * The upstream WS handshake watchdog can terminate a socket after removing
 * its listeners. `ws` then emits this error without an error listener. It is
 * a transient network condition (commonly after macOS wakes), not a daemon
 * invariant failure; the SDK's reconnect loop remains responsible for the
 * next connection attempt.
 */
export function isRecoverableTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === 'WebSocket was closed before the connection was established';
}
