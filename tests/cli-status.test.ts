import { describe, expect, it } from 'vitest';
import { fallbackRuntimeSessions, formatCliStatus } from '../src/cli-status.js';
import type { ManagedSession, SessionState } from '../src/core/model.js';
import type { RuntimeSessionStatus } from '../src/daemon/protocol.js';
import type { ScreenDetection, ScreenState } from '../src/screen/detector.js';

describe('CLI status table', () => {
  it('renders one table with sessions grouped by agent and one row per session', () => {
    const state = stateWith([
      session('docs', 'claude', '/work/docs'),
      session('backend', 'codex', '/work/backend'),
      session('helix', 'traex', '/work/helix'),
      session('assistant', 'codex', '/work/assistant'),
    ], 'assistant');
    const output = formatCliStatus({
      daemon: { status: 'running', pid: 42, version: '0.2.0' },
      cliVersion: '0.2.0',
      state,
      columns: 140,
      sessions: [
        runtime(state.sessions?.docs, 'idle'),
        runtime(state.sessions?.backend, 'running'),
        runtime(state.sessions?.helix, 'running'),
        runtime(state.sessions?.assistant, 'idle', true),
      ],
    });

    expect(output).toContain('Daemon: running · PID 42 · daemon 0.2.0 · CLI 0.2.0');
    expect(output).toContain('Sessions: 4');
    expect(output.indexOf('assistant')).toBeLessThan(output.indexOf('backend'));
    expect(output.indexOf('backend')).toBeLessThan(output.indexOf('helix'));
    expect(output.indexOf('helix')).toBeLessThan(output.indexOf('docs'));
    expect(output.match(/│ ●\s+│ codex\s+│ assistant/g)).toHaveLength(1);
    const sessionCells = output.split('\n')
      .filter((line) => line.startsWith('│'))
      .map((line) => line.split('│')[3]?.trim());
    for (const id of ['assistant', 'backend', 'helix', 'docs']) {
      expect(sessionCells.filter((cell) => cell === id)).toHaveLength(1);
    }
    expect(output.match(/^┌/gm)).toHaveLength(1);
    expect(output.match(/^└/gm)).toHaveLength(1);
  });

  it('keeps CJK table borders aligned and truncates a long path in the middle', () => {
    const item = session('assistant', 'codex', '/Users/feng/workspace/a-very-long-project-directory/packages/server');
    const state = stateWith([item], 'assistant');
    const output = formatCliStatus({
      daemon: { status: 'running', pid: 9, version: '0.2.0' },
      cliVersion: '0.2.0', state, columns: 92,
      sessions: [runtime(item, 'idle', true)],
    });
    const tableLines = output.split('\n').filter((line) => /^[┌├└│]/.test(line));
    expect(new Set(tableLines.map(terminalWidth)).size).toBe(1);
    expect(output).toContain('…');
    expect(output).toContain('/Users/');
    expect(output).toContain('/server');
    expect(output).toContain('等待用户输入');
  });

  it('maps interactions and dead panes to friendly status labels', () => {
    const approval = session('approval', 'codex', '/work/a');
    const question = session('question', 'traex', '/work/q');
    const stopped = session('stopped', 'claude', '/work/s');
    const state = stateWith([approval, question, stopped]);
    const approvalScreen = screen('approval');
    approvalScreen.interaction = { kind: 'approval', title: 'Allow?', context: [] };
    const questionScreen = screen('input');
    questionScreen.interaction = { kind: 'question', title: 'Choose?', context: [] };
    const output = formatCliStatus({
      daemon: { status: 'running' }, cliVersion: '0.2.0', state,
      sessions: [
        { session: approval, active: false, paneAlive: true, screen: approvalScreen },
        { session: question, active: false, paneAlive: true, screen: questionScreen },
        { session: stopped, active: false, paneAlive: false, screen: screen('exited') },
      ],
    });
    expect(output).toContain('等待审批');
    expect(output).toContain('等待回答');
    expect(output).toContain('已停止');
  });

  it('uses persisted sessions with unknown runtime state when daemon is unavailable', () => {
    const item = session('offline', 'claude', '/work/offline');
    const state = stateWith([item], 'offline');
    const sessions = fallbackRuntimeSessions(state);
    const output = formatCliStatus({
      daemon: { status: 'unresponsive', pid: 77 }, cliVersion: '0.2.0', state, sessions,
    });
    expect(sessions).toEqual([{ session: item, active: true }]);
    expect(output).toContain('Daemon: unresponsive · PID 77 · CLI 0.2.0');
    expect(output.match(/无法确认/g)).toHaveLength(2);
  });

  it('prints friendly empty and unknown-session messages without an empty table', () => {
    const state = stateWith([]);
    const empty = formatCliStatus({ daemon: { status: 'stopped' }, cliVersion: '0.2.0', state, sessions: [] });
    expect(empty).toContain('暂无受管 session。');
    expect(empty).not.toContain('┌');
    const missing = formatCliStatus({
      daemon: { status: 'running' }, cliVersion: '0.2.0', state, sessions: [], requestedSessionId: 'missing',
    });
    expect(missing).toContain('未找到 session「missing」');
    expect(missing).toContain('lca status');
  });
});

function session(id: string, agent: ManagedSession['agent'], cwd: string): ManagedSession {
  return { id, agent, cwd, sessionName: `lark-coding-assistant-${id}`, paneId: `%${id}`, agentVersion: 'v', updatedAt: 1 };
}

function stateWith(sessions: ManagedSession[], activeSessionId?: string): SessionState {
  return {
    schemaVersion: 2,
    sessions: Object.fromEntries(sessions.map((item) => [item.id, item])),
    activeSessionId,
    updatedAt: 1,
  };
}

function runtime(value: ManagedSession | undefined, state: ScreenState, active = false): RuntimeSessionStatus {
  if (!value) throw new Error('missing test session');
  return { session: value, active, paneAlive: state !== 'exited', screen: screen(state) };
}

function screen(state: ScreenState): ScreenDetection {
  return { state, confidence: 1, normalized: '', fingerprint: state, evidence: [], actions: [], hasDraftInput: false };
}

function terminalWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    width += code >= 0x2e80 && code <= 0x9fff ? 2 : 1;
  }
  return width;
}
