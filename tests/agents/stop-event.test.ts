import { describe, expect, it } from 'vitest';
import { normalizeSessionStartEvent, normalizeStopEvent } from '../../src/agents/stop-event.js';

describe('Stop event normalization', () => {
  it('normalizes a SessionStart payload with the native agent session id', () => {
    expect(normalizeSessionStartEvent('bridge-session', 'traex', {
      hook_event_name: 'SessionStart', session_id: 'native-thread', cwd: '/work/app', source: 'resume',
    })).toEqual({
      sessionId: 'bridge-session', agent: 'traex', agentSessionId: 'native-thread', cwd: '/work/app', source: 'resume',
    });
  });
  it.each([
    ['Codex', {
      session_id: 'codex-thread', turn_id: 'codex-turn', cwd: '/work/codex',
      hook_event_name: 'Stop', last_assistant_message: 'Codex result',
    }],
    ['Trae CLI', {
      session_id: 'trae-thread', turn_id: 'trae-turn', cwd: '/work/trae',
      hook_event_name: 'Stop', last_assistant_message: 'Trae result',
    }],
    ['Claude Code', {
      session_id: 'claude-thread', prompt_id: 'claude-prompt', cwd: '/work/claude',
      hook_event_name: 'Stop', last_assistant_message: 'Claude result',
    }],
  ])('normalizes a real %s Stop payload', (_name, payload) => {
    expect(normalizeStopEvent('bridge-session', payload)).toEqual({
      sessionId: 'bridge-session',
      eventId: 'turn_id' in payload ? payload.turn_id : payload.prompt_id,
      agentSessionId: payload.session_id,
      cwd: payload.cwd,
      lastAssistantMessage: payload.last_assistant_message,
    });
  });

  it('rejects non-Stop and incomplete hook payloads', () => {
    expect(normalizeStopEvent('session', { hook_event_name: 'PermissionRequest' })).toBeUndefined();
    expect(normalizeStopEvent('session', {
      hook_event_name: 'Stop', session_id: 'thread', turn_id: 'turn', cwd: '/work', last_assistant_message: '   ',
    })).toBeUndefined();
  });
});
