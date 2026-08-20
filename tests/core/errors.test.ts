import { describe, expect, it } from 'vitest';
import { AppError, asAppError, serializeAppError } from '../../src/core/errors.js';

describe('application errors', () => {
  it('serializes stable metadata without a stack', () => {
    const result = serializeAppError(new AppError(
      'SESSION_EXISTS',
      'session exists',
      { sessionId: 'assistant', ignored: undefined },
    ));
    expect(result).toEqual({
      error: 'session exists',
      errorCode: 'SESSION_EXISTS',
      errorContext: { sessionId: 'assistant' },
    });
    expect(JSON.stringify(result)).not.toContain('stack');
  });

  it('keeps legacy unknown errors string-compatible', () => {
    expect(serializeAppError(new Error('legacy failure'))).toEqual({ error: 'legacy failure' });
  });

  it('adds operation context without losing the original code', () => {
    const error = asAppError(
      new AppError('SESSION_NOT_FOUND', 'missing', { sessionId: 'api' }),
      'UNKNOWN',
      { operation: 'attach' },
    );
    expect(error.code).toBe('SESSION_NOT_FOUND');
    expect(error.context).toEqual({ operation: 'attach', sessionId: 'api' });
    expect(error.cause).toBeInstanceOf(AppError);
  });
});
