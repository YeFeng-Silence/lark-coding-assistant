import { describe, expect, it } from 'vitest';
import { getAgentAdapter, listAgentAdapters } from '../../src/agents/registry.js';

describe('coding agent adapters', () => {
  it('registers all coding agents in stable display order', () => {
    expect(listAgentAdapters().map(({ id }) => id)).toEqual(['codex', 'trae-cli', 'claude-code']);
  });

  it('builds Codex-style Stop hook and resume arguments for Trae CLI', () => {
    const args = getAgentAdapter('trae-cli').buildLaunchArgs({
      resume: { mode: 'last' },
      stopHookCommand: 'lark-coding-assistant hook stop',
    });
    expect(args).toEqual([
      '--dangerously-bypass-hook-trust',
      '-c',
      'hooks.Stop=[{hooks=[{type="command",command="lark-coding-assistant hook stop",timeout=5}]}]',
      'resume',
      '--last',
    ]);
  });

  it('builds Claude settings overlay and native resume arguments', () => {
    const args = getAgentAdapter('claude-code').buildLaunchArgs({
      resume: { mode: 'session', sessionId: 'claude-session' },
      stopHookCommand: 'lark-coding-assistant hook stop',
    });
    expect(args).toEqual([
      '--settings',
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'lark-coding-assistant hook stop', timeout: 5 }] }] } }),
      '--resume',
      'claude-session',
    ]);
  });
});
