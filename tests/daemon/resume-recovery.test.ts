import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardActionEvent } from '@larksuite/channel';
import { AssistantDaemon } from '../../src/daemon/server.js';
import { AppStore } from '../../src/core/store.js';
import { resolveAppPaths } from '../../src/core/paths.js';
import type { AppConfig, ManagedSession, SessionState } from '../../src/core/model.js';
import type { AgentId } from '../../src/agents/types.js';
import type { DaemonResult } from '../../src/daemon/protocol.js';
import type { LarkActionResult, RemoteGateway } from '../../src/lark/gateway.js';
import type { SignedAction } from '../../src/lark/action-signing.js';
import type { ScreenDetection } from '../../src/screen/detector.js';
import { getAgentAdapter } from '../../src/agents/registry.js';
import { parseResumePicker } from '../../src/screen/resume-picker.js';
import { resolveNativeAgentSessionId } from '../../src/session/native-session.js';
import type { StartSessionRequest } from '../../src/session/start-request.js';
import type { TmuxController } from '../../src/tmux/controller.js';
import type { TmuxSessionMetadata } from '../../src/tmux/types.js';

vi.mock('../../src/platform/process.js', () => ({ runFile: vi.fn(async () => ({ stdout: 'test-version', stderr: '' })) }));
vi.mock('../../src/session/native-session.js', () => ({ resolveNativeAgentSessionId: vi.fn() }));
vi.mock('../../src/session/start-request.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/session/start-request.js')>(),
  validateStartSessionRequest: vi.fn(async (request: StartSessionRequest) => request),
}));

const agents = ['codex', 'traex', 'claude'] as const;
beforeEach(() => { vi.useFakeTimers(); vi.mocked(resolveNativeAgentSessionId).mockReset().mockResolvedValue(undefined); });
afterEach(() => vi.useRealTimers());

describe.each(agents)('%s startup manual notification deduplication', (agent) => {
  it.each(['new', 'resume'] as const)('does not send a second watchdog card after a %s startup manual response', async (mode) => {
    const h = harness(agent);
    await finish(h.internal.startRemoteSession({ ...h.request, resume: mode === 'new' ? undefined : h.request.resume }));
    const pending = h.internal.state.sessions!.new!;
    const manual = await h.internal.startupManualResult(pending);
    if (manual.type !== 'manual') throw new Error('expected manual');
    h.internal.screen = manual.view.screen;
    const key = `${pending.id}:${pending.paneId}:${manual.view.screen.fingerprint}`;
    h.internal.unresolvedCandidate = { key, since: Date.now() - 4_000 };
    await h.internal.maybeNotifyUnresolved();
    expect(h.gateway.sendManual).not.toHaveBeenCalled();

    // Even if startup completes without a repaint, do not re-send the same view.
    h.internal.state.sessions!.new = { ...pending, startupRecovery: undefined };
    h.internal.unresolvedCandidate = { key, since: Date.now() - 4_000 };
    await h.internal.maybeNotifyUnresolved();
    expect(h.gateway.sendManual).not.toHaveBeenCalled();

    // A new unresolved runtime interaction still needs its own fallback card.
    h.internal.screen = getAgentAdapter(agent).detectScreen('A different unresolved runtime interaction', true);
    h.internal.unresolvedCandidate = {
      key: `${pending.id}:${pending.paneId}:${h.internal.screen.fingerprint}`, since: Date.now() - 4_000,
    };
    await h.internal.maybeNotifyUnresolved();
    expect(h.gateway.sendManual).toHaveBeenCalledTimes(1);
  });
});

describe.each(agents)('%s new-session startup recovery', (agent) => {
  it('allows manual control to complete a new session without requiring a native ID before the first message', async () => {
    const h = harness(agent);
    const result = await finish(h.internal.startRemoteSession({ ...h.request, resume: undefined }));
    expect(result).toMatchObject({ ok: true, state: 'manual', session: { startupRecovery: {
      phase: 'manual', previousSessionId: 'previous', previousPaneId: '%1', activationRevision: 1,
    } } });
    expect(h.tmux.create).toHaveBeenCalledWith(expect.objectContaining({ args: expect.not.arrayContaining(['resume', '--resume']) }));
    const pending = h.internal.state.sessions!.new!;
    expect(pending.startupRecovery?.resume).toBeUndefined();
    expect(h.metadata.at(-1)?.startupRecovery).toMatchObject({ phase: 'manual' });
    const manual = await h.internal.startupManualResult(pending);
    expect(manual).toMatchObject({ type: 'manual', content: expect.stringContaining('尚未完成会话创建') });
    h.internal.poll = async () => {
      h.internal.screen = getAgentAdapter(agent).detectScreen(h.output, true);
      await h.internal.refreshStartupRecovery();
      await h.internal.refreshNativeAgentSessionClaims();
    };
    h.tmux.sendKey.mockImplementation(async () => { h.output = readyScreen(agent); });
    const screen = getAgentAdapter(agent).detectScreen(h.output, true);
    const action = signed(pending, 'enter', screen.fingerprint, 'manual');
    expect(await finish(h.internal.handleManualAction(action, event(action)))).toMatchObject({ type: 'session-created' });
    expect(h.internal.state.sessions!.new!.startupRecovery).toBeUndefined();
    expect(h.internal.state.sessions!.new!.agentSessionId).toBeUndefined();
    expect(h.internal.state.activeSessionId).toBe('new');
    await h.internal.refreshStartupRecovery();
    expect(h.gateway.sendText).toHaveBeenCalledTimes(1);
    expect(h.tmux.killSession).not.toHaveBeenCalled();
  });

  it('creates normally when the input prompt is already available', async () => {
    const h = harness(agent);
    h.output = readyScreen(agent);
    expect(await finish(h.internal.startRemoteSession({ ...h.request, resume: undefined }))).toMatchObject({
      ok: true, state: 'ready', session: { startupRecovery: undefined },
    });
    expect(h.gateway.sendManual).not.toHaveBeenCalled();
  });

  it('checks an already available native identity before switching away from the original connection', async () => {
    const h = harness(agent);
    h.output = readyScreen(agent);
    vi.mocked(resolveNativeAgentSessionId).mockResolvedValue('native-previous');
    expect(await finish(h.internal.startRemoteSession({ ...h.request, resume: undefined }))).toMatchObject({
      ok: true, state: 'conflict', owner: { id: 'previous' },
    });
    expect(h.internal.state.activeSessionId).toBe('previous');
    expect(h.internal.state.sessions!.new).toBeUndefined();
  });

  it('does not mark unknown startup interactions complete just because a native identity exists', async () => {
    const h = harness(agent);
    vi.mocked(resolveNativeAgentSessionId).mockResolvedValue('native-new');
    await finish(h.internal.startRemoteSession({ ...h.request, resume: undefined }));
    await h.internal.refreshNativeAgentSessionClaims();
    expect(h.internal.state.sessions!.new!.startupRecovery?.phase).toBe('manual');
    expect(h.gateway.sendText).not.toHaveBeenCalled();
    h.output = readyScreen(agent);
    await h.internal.refreshStartupRecovery();
    expect(h.internal.state.sessions!.new!.startupRecovery).toBeUndefined();
    expect(h.internal.state.sessions!.new!.agentSessionId).toBe('native-new');
    expect(h.gateway.sendText).toHaveBeenCalledTimes(1);
  });

  it('returns to the original connection when pending new-session creation is cancelled after reload', async () => {
    const h = harness(agent);
    await finish(h.internal.startRemoteSession({ ...h.request, resume: undefined }));
    h.internal.state = JSON.parse(JSON.stringify(h.internal.state)) as SessionState;
    const manual = await h.internal.startupManualResult(h.internal.state.sessions!.new!);
    if (manual.type !== 'manual') throw new Error('expected manual');
    h.internal.screen = manual.view.screen;
    const action = signed(h.internal.state.sessions!.new!, 'cancel-create', manual.view.screen.fingerprint, 'manual');
    expect(await h.internal.handleManualAction(action, event(action))).toMatchObject({ type: 'success' });
    expect(h.internal.state.activeSessionId).toBe('previous');
    expect(h.gateway.sendText).toHaveBeenCalledWith('oc_1', expect.stringContaining('已恢复连接到「previous」'));
  });

  it('keeps an explicit user switch when a pending new session is stopped', async () => {
    const h = harness(agent);
    await finish(h.internal.startRemoteSession({ ...h.request, resume: undefined }));
    h.internal.state.sessions!.other = session('other', '%3', agent);
    await h.internal.useSession('other');
    await h.internal.stopSession('new');
    expect(h.internal.state.activeSessionId).toBe('other');
  });

  it('preserves a pending new terminal when its manual card cannot be sent', async () => {
    const h = harness(agent);
    await finish(h.internal.startRemoteSession({ ...h.request, resume: undefined }));
    h.gateway.sendManual.mockRejectedValueOnce(new Error('offline'));
    await h.internal.handleResumePickerDeliveryFailure(h.internal.state.sessions!.new!);
    expect(h.tmux.killSession).not.toHaveBeenCalled();
    expect(h.gateway.sendText).toHaveBeenCalledWith('oc_1', expect.stringContaining('尚未完成会话创建'));
    expect(h.internal.state.sessions!.new!.startupRecovery?.phase).toBe('manual');
  });

  it('still rejects a duplicate native identity after a new-session manual startup', async () => {
    const h = harness(agent);
    await finish(h.internal.startRemoteSession({ ...h.request, resume: undefined }));
    h.output = readyScreen(agent);
    vi.mocked(resolveNativeAgentSessionId).mockResolvedValue('native-previous');
    await h.internal.refreshStartupRecovery();
    expect(h.internal.state.sessions!.new).toBeUndefined();
    expect(h.internal.state.activeSessionId).toBe('previous');
    expect(h.internal.state.sessions!.previous!.agentSessionId).toBe('native-previous');
  });
});

describe.each(agents)('%s resume recovery', (agent) => {
  it('commits a live unknown startup screen for manual control and persists the original connection', async () => {
    const h = harness(agent);
    const result = await finish(h.internal.startRemoteSession(h.request));
    expect(result).toMatchObject({ ok: true, state: 'manual', session: { agent, startupRecovery: {
      phase: 'manual', previousSessionId: 'previous', previousPaneId: '%1', activationRevision: 1,
    } } });
    expect(h.internal.state.activeSessionId).toBe('new');
    expect(h.tmux.killSession).not.toHaveBeenCalled();
    expect(h.metadata.at(-1)?.startupRecovery?.phase).toBe('manual');
    const manual = await h.internal.startupManualResult(h.internal.state.sessions!.new!);
    expect(manual).toMatchObject({ type: 'manual', view: { output: expect.stringContaining('Update required') } });
  });

  it('returns the existing Picker without a manual card', async () => {
    const h = harness(agent);
    h.output = pickerScreen(agent);
    expect(await finish(h.internal.startRemoteSession(h.request))).toMatchObject({ ok: true, state: 'picker' });
    await h.internal.refreshStartupRecovery();
    expect(h.gateway.sendManual).not.toHaveBeenCalled();
    expect(h.gateway.sendResumePicker).not.toHaveBeenCalled();
  });

  it('allows manual Enter to reveal the Picker and then confirms the selected native identity', async () => {
    const h = harness(agent);
    await finish(h.internal.startRemoteSession(h.request));
    h.tmux.sendKey.mockImplementation(async () => { h.output = pickerScreen(agent); });
    const session = h.internal.state.sessions!.new!;
    const screen = getAgentAdapter(agent).detectScreen(h.output, true);
    h.internal.screen = screen;
    h.internal.poll = async () => {
      h.internal.screen = getAgentAdapter(agent).detectScreen(h.output, true);
      await h.internal.refreshStartupRecovery();
      await h.internal.refreshNativeAgentSessionClaims();
    };
    const action = signed(session, 'enter', screen.fingerprint, 'manual');
    const result = await finish(h.internal.handleManualAction(action, event(action)));
    expect(result).toMatchObject({ type: 'resume-picker', session: { id: 'new' } });
    const picker = parseResumePicker(h.output, agent)!;
    h.tmux.sendKey.mockImplementation(async () => { h.output = 'Ready for your next task'; });
    vi.mocked(resolveNativeAgentSessionId).mockResolvedValue('native-new');
    const selected = await finish(h.internal.handleResumePickerAction(signed(
      h.internal.state.sessions!.new!, `select:${picker.options[0]!.id}`, picker.fingerprint,
    )));
    expect(selected).toMatchObject({ type: 'session-created', session: { agentSessionId: 'native-new' } });
    expect(h.internal.state.sessions!.new!.startupRecovery).toBeUndefined();
    expect(h.internal.state.activeSessionId).toBe('new');
    await h.internal.refreshNativeAgentSessionClaims();
    expect(h.gateway.sendText).not.toHaveBeenCalledWith('oc_1', expect.stringContaining('已恢复连接'));
  });

  it('retains the terminal when an extra interaction prevents identity confirmation after selection', async () => {
    const h = harness(agent);
    h.output = pickerScreen(agent);
    await finish(h.internal.startRemoteSession(h.request));
    const picker = parseResumePicker(h.output, agent)!;
    h.tmux.sendKey.mockImplementation(async () => { h.output = 'Please sign in to continue'; });
    const result = await finish(h.internal.handleResumePickerAction(signed(
      h.internal.state.sessions!.new!, `select:${picker.options[0]!.id}`, picker.fingerprint,
    )), 5_000);
    expect(result).toMatchObject({ type: 'manual', view: { session: { startupRecovery: { phase: 'manual' } } } });
    expect(h.tmux.killSession).not.toHaveBeenCalled();
    expect(h.internal.state.activeSessionId).toBe('new');
  });

  it('restores the previous connection when manual creation is cancelled, including after reload', async () => {
    const h = harness(agent);
    await finish(h.internal.startRemoteSession(h.request));
    // AppStore reload preserves both the pending phase and activation revision.
    h.internal.state = JSON.parse(JSON.stringify(h.internal.state)) as SessionState;
    const manual = await h.internal.startupManualResult(h.internal.state.sessions!.new!);
    if (manual.type !== 'manual') throw new Error('expected manual');
    h.internal.screen = manual.view.screen;
    const action = signed(h.internal.state.sessions!.new!, 'cancel-create', manual.view.screen.fingerprint, 'manual');
    expect(await h.internal.handleManualAction(action, event(action))).toMatchObject({ type: 'success' });
    expect(h.internal.state.activeSessionId).toBe('previous');
    expect(h.internal.state.sessions!.new).toBeUndefined();
    expect(h.gateway.sendText).toHaveBeenCalledWith('oc_1', expect.stringContaining('已恢复连接到「previous」'));
  });

  it('preserves an explicit switch instead of returning to the original connection', async () => {
    const h = harness(agent);
    await finish(h.internal.startRemoteSession(h.request));
    const other = session('other', '%3', agent);
    h.internal.state.sessions!.other = other;
    await h.internal.useSession(other.id);
    await h.internal.stopSession('new');
    expect(h.internal.state.activeSessionId).toBe('other');
    expect(h.gateway.sendText).not.toHaveBeenCalled();
  });

  it('does not take over an explicit connection switch made during creation', async () => {
    const h = harness(agent);
    const other = session('other', '%3', agent);
    h.internal.state.sessions!.other = other;
    const creating = h.internal.startRemoteSession(h.request);
    await vi.advanceTimersByTimeAsync(1_000);
    await h.internal.useSession(other.id);
    expect(await finish(creating)).toMatchObject({ ok: true, state: 'manual' });
    expect(h.internal.state.activeSessionId).toBe('other');
    const manual = await h.internal.startupManualResult(h.internal.state.sessions!.new!);
    expect(manual).toMatchObject({ type: 'manual', view: { needsConnection: true } });
    await h.internal.stopSession('new');
    expect(h.internal.state.activeSessionId).toBe('other');
  });

  it('keeps a live terminal when the resume-selection transaction reaches its hard deadline', async () => {
    const h = harness(agent, 2_000);
    h.output = pickerScreen(agent);
    await finish(h.internal.startRemoteSession(h.request));
    const picker = parseResumePicker(h.output, agent)!;
    h.tmux.sendKey.mockImplementation(async () => { h.output = 'Additional confirmation required'; });
    const result = await finish(h.internal.handleResumePickerAction(signed(
      h.internal.state.sessions!.new!, `select:${picker.options[0]!.id}`, picker.fingerprint,
    )));
    expect(result).toMatchObject({ type: 'manual' });
    expect(h.tmux.killSession).not.toHaveBeenCalled();
    expect(h.internal.state.sessions!.new!.startupRecovery?.phase).toBe('manual');
  });

  it('rolls back a dead terminal after selecting a history entry', async () => {
    const h = harness(agent);
    h.output = pickerScreen(agent);
    await finish(h.internal.startRemoteSession(h.request));
    const picker = parseResumePicker(h.output, agent)!;
    h.tmux.sendKey.mockImplementation(async () => {
      h.tmux.inspect.mockImplementation(async () => ({ paneId: '%2', pid: 42, dead: true, cursorX: 0, cursorY: 0 }));
    });
    expect(await finish(h.internal.handleResumePickerAction(signed(
      h.internal.state.sessions!.new!, `select:${picker.options[0]!.id}`, picker.fingerprint,
    )))).toMatchObject({ type: 'session-start-failed' });
    expect(h.internal.state.sessions!.new).toBeUndefined();
    // The fixture marks every pane dead, so the original connection is also unavailable.
    expect(h.gateway.sendSessionPicker).toHaveBeenCalled();
  });

  it('offers sessions when the previous connection no longer exists', async () => {
    const h = harness(agent);
    await finish(h.internal.startRemoteSession(h.request));
    delete h.internal.state.sessions!.previous;
    await h.internal.stopSession('new');
    expect(h.internal.state.activeSessionId).toBeUndefined();
    expect(h.gateway.sendSessionPicker).toHaveBeenCalled();
  });

  it('retains the terminal and offers manual recovery when Picker delivery fails', async () => {
    const h = harness(agent);
    h.output = pickerScreen(agent);
    await finish(h.internal.startRemoteSession(h.request));
    await h.internal.handleResumePickerDeliveryFailure(h.internal.state.sessions!.new!);
    expect(h.tmux.killSession).not.toHaveBeenCalled();
    expect(h.gateway.sendManual).toHaveBeenCalled();
    expect(h.internal.state.sessions!.new!.startupRecovery?.phase).toBe('manual');
  });

  it('confirms a manual selection once and keeps native-session duplicate protection', async () => {
    const h = harness(agent);
    await finish(h.internal.startRemoteSession(h.request));
    h.output = 'Ready';
    vi.mocked(resolveNativeAgentSessionId).mockResolvedValue('native-new');
    await h.internal.refreshNativeAgentSessionClaims();
    await h.internal.refreshNativeAgentSessionClaims();
    expect(h.internal.state.sessions!.new!.agentSessionId).toBe('native-new');
    expect(h.internal.state.sessions!.new!.startupRecovery).toBeUndefined();
    expect(h.gateway.sendText).toHaveBeenCalledTimes(1);

    const duplicate = harness(agent);
    await finish(duplicate.internal.startRemoteSession(duplicate.request));
    duplicate.internal.state.sessions!.previous!.agentSessionId = 'native-new';
    await duplicate.internal.refreshNativeAgentSessionClaims();
    expect(duplicate.internal.state.sessions!.new).toBeUndefined();
    expect(duplicate.internal.state.activeSessionId).toBe('previous');
    expect(duplicate.internal.state.sessions!.previous!.agentSessionId).toBe('native-new');
  });
});

function session(id: string, paneId: string, agent: AgentId): ManagedSession {
  return { id, paneId, agent, sessionName: `lca-${id}`, cwd: '/tmp', agentVersion: 'test', updatedAt: 1 };
}

function pickerScreen(agent: AgentId): string {
  return agent === 'claude'
    ? 'Resume session\n⌕ Search…\n❯ Previous task\n1 day ago · HEAD · 1KB\nCtrl+A to show all projects'
    : 'Resume a previous session\nType to search\n❯ 1d ago Previous task\nenter resume';
}

function readyScreen(agent: AgentId): string {
  return agent === 'claude' ? 'Claude Code\n❯ ' : agent === 'traex' ? 'TraeCode CLI\n› ' : 'OpenAI Codex\n› ';
}

async function finish<T>(operation: Promise<T>, ms = 4_000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return operation;
}

function signed(value: ManagedSession, action: string, fingerprint: string, kind: SignedAction['kind'] = 'resume-picker'): SignedAction {
  return { v: 1, kind, sessionId: value.id, agent: value.agent, paneId: value.paneId, action, fingerprint,
    chatId: 'oc_1', nonce: 'test', sig: 'test', expiresAt: Date.now() + 60_000 };
}

function event(action: SignedAction): CardActionEvent {
  return { chatId: 'oc_1', messageId: 'manual-1', operator: { openId: 'ou_1' }, action: { value: action } } as CardActionEvent;
}

function harness(agent: AgentId, timeout = 30_000) {
  const paths = resolveAppPaths('/tmp/lca-resume-unit');
  const store = new AppStore(paths);
  vi.spyOn(store, 'saveState').mockResolvedValue();
  const daemon = new AssistantDaemon(store, paths, undefined, undefined, undefined, undefined, undefined, timeout);
  const internal = daemon as unknown as Internals;
  const previous = { ...session('previous', '%1', agent), agentSessionId: 'native-previous' };
  internal.state = { schemaVersion: 2, ownerOpenId: 'ou_1', boundChatId: 'oc_1', activeSessionId: previous.id,
    sessions: { previous }, updatedAt: 1 };
  internal.config = { agentBinaries: { codex: 'codex', traex: 'traex', claude: 'claude' } } as AppConfig;
  internal.log = vi.fn(async () => undefined);
  internal.reconcileSessions = vi.fn(async () => Object.values(internal.state.sessions!));
  internal.poll = vi.fn(async () => undefined);
  const metadata: TmuxSessionMetadata[] = [];
  const tmux = {
    create: vi.fn(async () => ({ sessionName: 'lca-new', paneId: '%2', pid: 42 })),
    inspect: vi.fn(async () => ({ paneId: '%2', pid: 42, dead: false, cursorX: 0, cursorY: 0 })),
    capture: vi.fn(async () => h.output),
    killSession: vi.fn(async () => undefined),
    writeMetadata: vi.fn(async (_name: string, value: TmuxSessionMetadata) => { metadata.push(value); }),
    preserveOnExit: vi.fn(async () => undefined),
    sendKey: vi.fn(async () => undefined),
    sendText: vi.fn(async () => undefined),
    hasSession: vi.fn(async () => true),
    findBySession: vi.fn(async () => ({ paneId: '%2', pid: 42, dead: false })),
  };
  internal.tmux = tmux as unknown as TmuxController;
  const gateway = {
    sendText: vi.fn(async () => undefined), sendManual: vi.fn(async () => undefined),
    sendResumePicker: vi.fn(async () => undefined), sendSessionPicker: vi.fn(async () => undefined),
  };
  internal.gateway = gateway as unknown as RemoteGateway;
  const h = { internal, tmux, gateway, metadata, output: 'Update required: choose an option to continue',
    request: { sessionId: 'new', agent, cwd: '/tmp', resume: { mode: 'picker' as const } } };
  return h;
}

interface Internals {
  state: SessionState;
  config: AppConfig;
  screen?: ScreenDetection;
  unresolvedCandidate?: { key: string; since: number };
  tmux: TmuxController;
  gateway: RemoteGateway;
  log(message: string): Promise<void>;
  poll(): Promise<void>;
  reconcileSessions(): Promise<ManagedSession[]>;
  startRemoteSession(request: StartSessionRequest): Promise<unknown>;
  startupManualResult(session: ManagedSession): Promise<LarkActionResult>;
  refreshStartupRecovery(): Promise<void>;
  refreshNativeAgentSessionClaims(): Promise<void>;
  maybeNotifyUnresolved(): Promise<void>;
  handleManualAction(action: SignedAction, event: CardActionEvent): Promise<LarkActionResult>;
  handleResumePickerAction(action: SignedAction): Promise<LarkActionResult>;
  handleResumePickerDeliveryFailure(session: ManagedSession): Promise<void>;
  stopSession(id: string): Promise<DaemonResult>;
  useSession(id: string): Promise<DaemonResult>;
}
