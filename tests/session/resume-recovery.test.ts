import { describe, expect, it } from 'vitest';
import type { ManagedSession, SessionState } from '../../src/core/model.js';
import { newSessionPromptReady, parseStartupRecovery, startupRollbackTarget } from '../../src/session/startup-recovery.js';
import { getAgentAdapter } from '../../src/agents/registry.js';

describe('resume rollback identity', () => {
  const previous: ManagedSession = { id: 'previous', agent: 'codex', paneId: '%1', sessionName: 'lca-previous',
    cwd: '/tmp', agentVersion: 'test', updatedAt: 1 };
  const pending: ManagedSession = { ...previous, id: 'pending', paneId: '%2', startupRecovery: {
    phase: 'manual', resume: { mode: 'picker' }, previousSessionId: previous.id, previousPaneId: previous.paneId,
    activationRevision: 3,
  } };
  const state: SessionState = { schemaVersion: 2, sessions: { previous, pending }, activeSessionId: pending.id,
    connectionRevision: 3, updatedAt: 1 };

  it('returns to the original pane after reloading persisted state', () => {
    expect(startupRollbackTarget(JSON.parse(JSON.stringify(state)), pending, { previous })).toBe('previous');
  });
  it('does not return to a same-name replacement pane', () => {
    expect(startupRollbackTarget(state, pending, { previous: { ...previous, paneId: '%9' } })).toBeUndefined();
  });
  it('does not undo an explicit switch away and back', () => {
    expect(startupRollbackTarget({ ...state, connectionRevision: 5 }, pending, { previous })).toBeUndefined();
  });
  it('ignores stale rollback state after the active connection changes', () => {
    expect(startupRollbackTarget({ ...state, activeSessionId: 'other' }, pending, { previous })).toBeUndefined();
  });
  it('reads valid metadata and ignores malformed or incompatible values', () => {
    expect(parseStartupRecovery(JSON.stringify(pending.startupRecovery))).toEqual(pending.startupRecovery);
    expect(parseStartupRecovery('{"phase":"manual"}')).toEqual({ phase: 'manual' });
    for (const value of [undefined, '', '{', 'null', '{}', '{"phase":"bad"}',
      '{"phase":"manual","resume":{"mode":"session"}}',
      '{"phase":"manual","resume":{"mode":"picker"},"activationRevision":"3"}']) {
      expect(parseStartupRecovery(value)).toBeUndefined();
    }
  });

  it.each(['codex', 'traex', 'claude'] as const)('only considers an empty usable %s prompt ready for new-session creation', (agent) => {
    const adapter = getAgentAdapter(agent);
    expect(newSessionPromptReady(adapter.detectScreen('› ', true))).toBe(true);
    for (const screen of ['Update required', 'Please sign in', 'Do you trust the contents of this directory?',
      '› draft input', 'Update required\n❯ Upgrade now', 'Working…']) {
      expect(newSessionPromptReady(adapter.detectScreen(screen, true))).toBe(false);
    }
  });
});
