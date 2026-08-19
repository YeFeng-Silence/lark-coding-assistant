import { describe, expect, it } from 'vitest';
import type { CardActionEvent } from '@larksuite/channel';
import { AssistantDaemon } from '../../src/daemon/server.js';
import type { ManagedSession, SessionState } from '../../src/core/model.js';
import type { ScreenDetection } from '../../src/screen/detector.js';
import type { SignedAction } from '../../src/lark/action-signing.js';
import type { LarkActionResult, RemoteGateway } from '../../src/lark/gateway.js';
import type { ManualControlView } from '../../src/lark/cards.js';

describe('manual terminal control', () => {
  it('executes one fresh key and refreshes instead of executing a stale action', async () => {
    const { daemon, internal, session } = harness();
    const keys: string[] = [];
    internal.tmux = {
      sendKey: async (_paneId, key) => { keys.push(key); },
      sendText: async () => undefined,
    };
    const fresh = manualAction(session, 'enter', 'fp-1');
    const result = await internal.handleManualAction(fresh, event(fresh));
    expect(result).toMatchObject({ type: 'manual', content: '按键 enter已执行。' });
    expect(keys).toEqual(['Enter']);

    const backspace = manualAction(session, 'backspace', 'fp-1');
    await internal.handleManualAction(backspace, event(backspace));
    expect(keys).toEqual(['Enter', 'BSpace']);

    const stale = manualAction(session, 'down', 'old-fingerprint');
    const staleResult = await internal.handleManualAction(stale, event(stale));
    expect(staleResult).toMatchObject({ type: 'manual', view: { state: 'stale' } });
    expect(keys).toEqual(['Enter', 'BSpace']);
    expect(daemon).toBeDefined();
  });

  it('distinguishes type-only from type-and-submit', async () => {
    const { internal, session } = harness();
    const writes: Array<{ text: string; submit: boolean }> = [];
    internal.tmux = {
      sendKey: async () => undefined,
      sendText: async (_paneId, text, submit) => { writes.push({ text, submit }); },
    };
    const type = manualAction(session, 'type', 'fp-1');
    await internal.handleManualAction(type, event(type, 'draft'));
    const submit = manualAction(session, 'submit', 'fp-1');
    await internal.handleManualAction(submit, event(submit, 'answer'));
    expect(writes).toEqual([
      { text: 'draft', submit: false },
      { text: 'answer', submit: true },
    ]);
  });

  it('waits for a stable repaint before signing the next manual view', async () => {
    const { internal, session } = harness();
    const fingerprints = ['transient', 'stable', 'stable'];
    internal.poll = async () => {
      const fingerprint = fingerprints.shift();
      if (fingerprint) internal.screen = { ...internal.screen, fingerprint };
    };
    internal.tmux = {
      sendKey: async () => undefined,
      sendText: async () => undefined,
    };
    const action = manualAction(session, 'ctrl-c', 'transient');
    const result = await internal.handleManualAction(action, event(action));
    expect(result).toMatchObject({ type: 'manual', view: { screen: { fingerprint: 'stable' } } });
    expect(fingerprints).toEqual([]);
  });

  it('keeps explicit manual control when a structured interaction is recognized', async () => {
    const { internal, session } = harness();
    internal.tmux = {
      sendKey: async () => undefined,
      sendText: async () => undefined,
    };
    internal.screen = {
      ...unresolvedScreen(),
      confidence: 0.95,
      interaction: {
        kind: 'question', interactionId: 'question-1', revision: 'question-rev',
        title: 'Choose', context: [],
        semantics: {
          cardinality: 'many', activation: 'toggle', toggleKey: 'Space',
          commit: { mode: 'key', key: 'Enter' }, confidence: 0.95, evidence: ['multi-select'],
        },
        actionConfidence: 0.95,
      },
      actions: [{ id: 'answer-1', key: '1', label: 'First', role: 'answer' }],
    };
    const action = manualAction(session, 'refresh', internal.screen.fingerprint, 'explicit');
    const result = await internal.handleManualAction(action, event(action));
    expect(result).toMatchObject({ type: 'manual', view: { state: 'active', mode: 'explicit' } });
  });

  it('permanently rejects controls from a manual card after it is closed', async () => {
    const { internal, session } = harness();
    const keys: string[] = [];
    internal.tmux = {
      sendKey: async (_paneId, key) => { keys.push(key); },
      sendText: async () => undefined,
    };
    const close = manualAction(session, 'exit', 'fp-1', 'explicit');
    expect(await internal.handleManualAction(close, event(close))).toMatchObject({
      type: 'manual', view: { state: 'exited' },
    });
    const enter = manualAction(session, 'enter', 'fp-1', 'explicit');
    expect(await internal.handleManualAction(enter, event(enter))).toMatchObject({
      type: 'manual', content: '该手动遥控卡已经结束。', view: { state: 'exited' },
    });
    expect(keys).toEqual([]);
  });

  it('sends one watchdog card for a stable unresolved snapshot', async () => {
    const { internal, session } = harness();
    const views: ManualControlView[] = [];
    internal.gateway = gateway({ sendManual: async (_chatId, view) => { views.push(view); } });
    internal.unresolvedCandidate = { key: `${session.id}:${session.paneId}:fp-1`, since: Date.now() - 4_000 };
    await internal.maybeNotifyUnresolved();
    await internal.maybeNotifyUnresolved();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ session: { id: 'assistant' }, screen: { state: 'unknown' } });
  });
});

function harness(): {
  daemon: AssistantDaemon;
  internal: InternalDaemon;
  session: ManagedSession;
} {
  const session: ManagedSession = {
    id: 'assistant', agent: 'codex', sessionName: 'lca-assistant', paneId: '%1',
    cwd: '/tmp', agentVersion: 'test', updatedAt: 1,
  };
  const daemon = Object.create(AssistantDaemon.prototype) as AssistantDaemon;
  const internal = daemon as unknown as InternalDaemon;
  internal.state = {
    schemaVersion: 2, ownerOpenId: 'ou_1', boundChatId: 'oc_1', activeSessionId: session.id,
    sessions: { [session.id]: session }, updatedAt: 1,
  };
  internal.screen = unresolvedScreen();
  internal.interactionNotificationsSuppressed = 0;
  internal.unresolvedNotified = new Set();
  internal.closedManualCards = new Set();
  internal.poll = async () => undefined;
  internal.gateway = gateway();
  return { daemon, internal, session };
}

interface InternalDaemon {
  state: SessionState;
  screen: ScreenDetection;
  interactionNotificationsSuppressed: number;
  unresolvedCandidate?: { key: string; since: number };
  unresolvedNotified: Set<string>;
  closedManualCards: Set<string>;
  gateway: RemoteGateway;
  tmux: {
    sendKey(paneId: string, key: string): Promise<void>;
    sendText(paneId: string, text: string, submit: boolean): Promise<void>;
  };
  poll(): Promise<void>;
  handleManualAction(action: SignedAction, event: CardActionEvent): Promise<LarkActionResult>;
  maybeNotifyUnresolved(): Promise<void>;
}

function unresolvedScreen(): ScreenDetection {
  return {
    state: 'unknown', confidence: 0.4, normalized: 'Unknown terminal prompt', fingerprint: 'fp-1',
    evidence: [], actions: [], hasDraftInput: false,
  };
}

function manualAction(
  session: ManagedSession,
  action: string,
  fingerprint: string,
  manualMode: 'explicit' | 'fallback' = 'fallback',
): SignedAction {
  return {
    v: 1, kind: 'manual', sessionId: session.id, manualMode, agent: session.agent, action,
    paneId: session.paneId, fingerprint, chatId: 'oc_1', nonce: 'test',
    expiresAt: Date.now() + 60_000, sig: 'test',
  };
}

function event(action: SignedAction, text?: string): CardActionEvent {
  return {
    messageId: 'om_1', chatId: 'oc_1', operator: { openId: 'ou_1' },
    action: {
      value: action, tag: 'button',
      formValue: text === undefined ? undefined : { manual_text: text },
    },
  } as CardActionEvent;
}

function gateway(overrides: Partial<RemoteGateway> = {}): RemoteGateway {
  return {
    connect: async () => undefined,
    disconnect: async () => undefined,
    sendText: async () => undefined,
    sendMarkdown: async () => undefined,
    sendChoice: async () => undefined,
    updateChoice: async () => undefined,
    completeChoiceInput: async () => undefined,
    sendManual: async () => undefined,
    sendStatus: async () => undefined,
    sendSessionPicker: async () => undefined,
    sendStopConfirmation: async () => undefined,
    ...overrides,
  };
}
