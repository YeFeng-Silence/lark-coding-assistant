import { describe, expect, it } from 'vitest';
import { assertSafeTmuxTarget, sanitizeRemoteInput, shellQuote } from '../../src/tmux/input.js';

describe('tmux input safety', () => {
  it('removes terminal control characters but preserves newlines and tabs', () => {
    expect(sanitizeRemoteInput('one\u001b[31m\ntwo\tthree\u0000')).toBe('one\ntwo\tthree');
  });

  it('accepts only exact pane ids', () => {
    expect(() => assertSafeTmuxTarget('%12')).not.toThrow();
    expect(() => assertSafeTmuxTarget('lca:0.0')).toThrow();
    expect(() => assertSafeTmuxTarget('%1; kill-server')).toThrow();
  });

  it('quotes shell arguments safely', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});
