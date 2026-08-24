import { describe, expect, it } from 'vitest';
import { getAgentAdapter, listAgentAdapters, normalizeAgentId } from '../../src/agents/registry.js';

describe('coding agent adapters', () => {
  it('registers all coding agents in stable display order', () => {
    expect(listAgentAdapters().map(({ id }) => id)).toEqual(['codex', 'traex', 'claude']);
  });

  it('normalizes legacy user-facing agent aliases', () => {
    expect(normalizeAgentId('codex')).toBe('codex');
    expect(normalizeAgentId('traex')).toBe('traex');
    expect(normalizeAgentId('claude')).toBe('claude');
    expect(normalizeAgentId('trae-cli')).toBe('traex');
    expect(normalizeAgentId('claude-code')).toBe('claude');
    expect(normalizeAgentId('unknown')).toBeUndefined();
  });

  it('builds Codex-style Stop hook and resume arguments for Trae CLI', () => {
    const args = getAgentAdapter('traex').buildLaunchArgs({
      resume: { mode: 'last' },
      stopHookCommand: 'lark-coding-assistant hook stop',
    });
    expect(args).toEqual([
      '--dangerously-bypass-hook-trust',
      '-c',
      'hooks.SessionStart=[{hooks=[{type="command",command="lark-coding-assistant hook stop",timeout=5}]}]',
      '-c',
      'hooks.Stop=[{hooks=[{type="command",command="lark-coding-assistant hook stop",timeout=5}]}]',
      'resume',
      '--last',
    ]);
  });

  it('builds Claude settings overlay and native resume arguments', () => {
    const args = getAgentAdapter('claude').buildLaunchArgs({
      resume: { mode: 'session', sessionId: 'claude-session' },
      stopHookCommand: 'lark-coding-assistant hook stop',
    });
    expect(args).toEqual([
      '--settings',
      JSON.stringify({ hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'lark-coding-assistant hook stop', timeout: 5 }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'lark-coding-assistant hook stop', timeout: 5 }] }],
      } }),
      '--resume',
      'claude-session',
    ]);
  });
});
