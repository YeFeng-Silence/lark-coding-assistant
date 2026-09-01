import { describe, expect, it } from 'vitest';
import type { ManagedSession, SessionState } from '../../src/core/model.js';
import { SessionReconciler, inferLegacyAgent, type SessionTmux } from '../../src/session/reconciler.js';
import type { TmuxInspectResult, TmuxPane, TmuxSessionMetadata } from '../../src/tmux/types.js';

describe('SessionReconciler', () => {
  it('keeps state on transient tmux failures', async () => {
    const tmux = new FakeTmux();
    tmux.inspectResult = { status: 'unavailable', error: new Error('temporary socket failure') };
    const reconciler = new SessionReconciler(tmux, 'lark-coding-assistant', 3);
    const result = await reconciler.reconcile(stateWith(session('helix', 'traex')));
    expect(result.state.sessions?.helix).toBeDefined();
    expect(result.changed).toBe(false);
  });

  it('requires three independently confirmed misses before removal', async () => {
    const tmux = new FakeTmux();
    tmux.inspectResult = { status: 'missing' };
    tmux.sessionResult = { status: 'missing' };
    const reconciler = new SessionReconciler(tmux, 'lark-coding-assistant', 3);
    let state = stateWith(session('helix', 'traex'));
    state = (await reconciler.reconcile(state)).state;
    expect(state.sessions?.helix).toBeDefined();
    state = (await reconciler.reconcile(state)).state;
    expect(state.sessions?.helix).toBeDefined();
    const result = await reconciler.reconcile(state);
    expect(result.state.sessions?.helix).toBeUndefined();
    expect(result.removedActive?.id).toBe('helix');
  });

  it('removes a confirmed dead session immediately and cleans its tmux container', async () => {
    const tmux = new FakeTmux();
    const deadPane = { ...pane('lark-coding-assistant-test', '%9', 'trae-cli'), dead: true, exitStatus: 0 };
    tmux.inspectResult = { status: 'dead', pane: deadPane };
    tmux.sessionResult = { status: 'dead', pane: deadPane };
    tmux.terminalOutput = 'Error: native session is already active';
    const reconciler = new SessionReconciler(tmux);
    const result = await reconciler.reconcile(stateWith(session('test', 'traex')));
    expect(result.state.sessions?.test).toBeUndefined();
    expect(result.removedActive?.id).toBe('test');
    expect(result.removedSessions).toMatchObject([{
      session: { id: 'test' },
      pane: { paneId: '%9', exitStatus: 0 },
      terminalOutput: 'Error: native session is already active',
    }]);
    expect(tmux.killed).toEqual(['lark-coding-assistant-test']);
  });

  it('cleans an orphaned dead LCA tmux session during discovery', async () => {
    const tmux = new FakeTmux();
    tmux.panes = [{ ...pane('lark-coding-assistant-test', '%9', 'trae-cli'), dead: true, exitStatus: 0 }];
    const reconciler = new SessionReconciler(tmux);
    const result = await reconciler.reconcile({ schemaVersion: 2, sessions: {}, updatedAt: 1 }, true);
    expect(result.state.sessions?.test).toBeUndefined();
    expect(tmux.killed).toEqual(['lark-coding-assistant-test']);
  });

  it('recovers a marked orphan session and chooses it as active', async () => {
    const tmux = new FakeTmux();
    tmux.panes = [pane('lark-coding-assistant-docs', '%3', 'claude')];
    tmux.metadata.set('lark-coding-assistant-docs', {
      managed: true, sessionId: 'docs', agent: 'claude', cwd: '/work/docs', agentVersion: '2.1.237',
    });
    const reconciler = new SessionReconciler(tmux);
    const result = await reconciler.reconcile({ schemaVersion: 2, sessions: {}, updatedAt: 1 }, true);
    expect(result.state.sessions?.docs).toMatchObject({ agent: 'claude', paneId: '%3', cwd: '/work/docs' });
    expect(result.state.activeSessionId).toBe('docs');
  });

  it('recovers and marks a legacy Trae session', async () => {
    const tmux = new FakeTmux();
    tmux.panes = [pane('lark-coding-assistant-helix', '%282', "'/usr/bin/env' 'trae-cli' 'resume'", 'traex')];
    const reconciler = new SessionReconciler(tmux, 'lark-coding-assistant', 3, async () => undefined, async () => '0.201.4');
    const result = await reconciler.reconcile({ schemaVersion: 2, sessions: {}, updatedAt: 1 }, true);
    expect(result.state.sessions?.helix).toMatchObject({ agent: 'traex', paneId: '%282', agentVersion: '0.201.4' });
    expect(tmux.metadata.get('lark-coding-assistant-helix')).toMatchObject({ sessionId: 'helix', agent: 'traex' });
  });
});

describe('inferLegacyAgent', () => {
  it('only recognizes supported agent commands', () => {
    expect(inferLegacyAgent({ startCommand: "'trae-cli' resume", currentCommand: 'traex' })).toBe('traex');
    expect(inferLegacyAgent({ startCommand: "'claude' --continue", currentCommand: 'claude' })).toBe('claude');
    expect(inferLegacyAgent({ startCommand: "'codex'", currentCommand: 'codex' })).toBe('codex');
    expect(inferLegacyAgent({ startCommand: "'bash'", currentCommand: 'zsh' })).toBeUndefined();
  });
});

class FakeTmux implements SessionTmux {
  inspectResult: TmuxInspectResult = { status: 'live', pane: pane('lark-coding-assistant-helix', '%2', 'trae-cli') };
  sessionResult: TmuxInspectResult = this.inspectResult;
  panes: TmuxPane[] = [];
  metadata = new Map<string, TmuxSessionMetadata>();
  killed: string[] = [];
  terminalOutput = '';

  async inspectStatus(): Promise<TmuxInspectResult> { return this.inspectResult; }
  async inspectSession(): Promise<TmuxInspectResult> { return this.sessionResult; }
  async listSessions(): Promise<TmuxPane[]> { return this.panes; }
  async readMetadata(name: string): Promise<TmuxSessionMetadata | undefined> { return this.metadata.get(name); }
  async writeMetadata(name: string, metadata: TmuxSessionMetadata): Promise<void> { this.metadata.set(name, metadata); }
  async capture(): Promise<string> { return this.terminalOutput; }
  async killSession(name: string): Promise<void> { this.killed.push(name); }
}

function pane(sessionName: string, paneId: string, startCommand: string, currentCommand = startCommand): TmuxPane {
  return { sessionName, paneId, pid: 1, startCommand, currentCommand, cwd: '/work/helix', dead: false, cursorX: 0, cursorY: 0 };
}

function session(id: string, agent: ManagedSession['agent']): ManagedSession {
  return { id, agent, sessionName: `lark-coding-assistant-${id}`, paneId: '%2', cwd: '/work', agentVersion: 'v', updatedAt: 1 };
}

function stateWith(value: ManagedSession): SessionState {
  return { schemaVersion: 2, sessions: { [value.id]: value }, activeSessionId: value.id, updatedAt: 1 };
}
