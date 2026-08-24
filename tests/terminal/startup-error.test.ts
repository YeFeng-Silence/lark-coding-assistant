import { describe, expect, it } from 'vitest';
import { startupTerminalExcerpt } from '../../src/terminal/startup-error.js';

describe('startupTerminalExcerpt', () => {
  it('keeps a Codex active-writer error without interpreting it', () => {
    const result = startupTerminalExcerpt(`╭────────╮
│ Codex  │
╰────────╯
Resuming session…
› Error: thread/resume failed: thread 01a0232f already has an active writer (code -32600)

Pane is dead (status 1)`);
    expect(result).toBe('› Error: thread/resume failed: thread 01a0232f already has an active writer (code -32600)');
  });

  it.each([
    ['traex', 'Fatal: session peer exited unexpectedly'],
    ['claude', 'Error: conversation could not be resumed'],
  ])('uses the same extraction for %s', (_agent, message) => {
    expect(startupTerminalExcerpt(`Starting…\n${message}`)).toBe(message);
  });

  it('strips terminal controls and redacts common credentials', () => {
    const result = startupTerminalExcerpt(
      '\u001b[31mError:\u001b[0m Authorization: Bearer abc123 api_key=secret Cookie: sid=value https://x.test?a=1&token=url-secret',
    );
    expect(result).toContain('Error: Authorization: [REDACTED]');
    expect(result).toContain('api_key=[REDACTED]');
    expect(result).toContain('Cookie: [REDACTED]');
    expect(result).toContain('token=[REDACTED]');
    expect(result).not.toContain('abc123');
    expect(result).not.toContain('url-secret');
  });

  it('limits output by lines and characters', () => {
    const lines = ['Error: failed', ...Array.from({ length: 25 }, (_, index) => `detail ${index}`)];
    const result = startupTerminalExcerpt(lines.join('\n'));
    expect(result.split('\n')).toHaveLength(21);
    expect(result).toContain('… 输出已截断');
    expect(startupTerminalExcerpt(`Error: ${'x'.repeat(2_100)}`).length).toBeLessThanOrEqual(2_010);
  });

  it('uses a stable fallback for empty terminal output', () => {
    expect(startupTerminalExcerpt('\u001b[0m\nPane is dead (status 1)')).toBe('Agent 未输出可用错误信息。');
  });
});
