import { describe, expect, it } from 'vitest';
import { isRecoverableTransportError } from '../../src/daemon/transport-errors.js';

describe('recoverable daemon transport errors', () => {
  it('keeps the known transient WebSocket handshake close recoverable', () => {
    expect(isRecoverableTransportError(new Error('WebSocket was closed before the connection was established'))).toBe(true);
  });

  it('does not hide unrelated daemon failures', () => {
    expect(isRecoverableTransportError(new Error('state write failed'))).toBe(false);
    expect(isRecoverableTransportError('WebSocket was closed before the connection was established')).toBe(false);
  });
});
