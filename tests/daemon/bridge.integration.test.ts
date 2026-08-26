import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { AssistantDaemon } from '../../src/daemon/server.js';
import { requestDaemon } from '../../src/daemon/client.js';
import { resolveAppPaths } from '../../src/core/paths.js';
import { AppStore } from '../../src/core/store.js';
import type { GatewayFactory, LarkActionResult, LarkGatewayHandler, RemoteGateway } from '../../src/lark/gateway.js';
import type { ManagedSession } from '../../src/core/model.js';
import type { SignedAction } from '../../src/lark/action-signing.js';
import type { ScreenDetection } from '../../src/screen/detector.js';
import type { RuntimeStatus } from '../../src/daemon/protocol.js';
import type { ManualControlView } from '../../src/lark/cards.js';
import type { SessionStartupFailure } from '../../src/session/startup-failure.js';
import { runFile } from '../../src/platform/process.js';
import type { SessionCreateView } from '../../src/workspace/session-create.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe.runIf(await hasTmux())('daemon bridge integration', () => {
  it('binds one private owner and forwards ordinary messages into the managed pane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lca-daemon-'));
    const paths = resolveAppPaths(root);
    const store = new AppStore(paths);
    const fakeCodex = join(root, 'fake-codex.mjs');
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 0.147.0'); process.exit(0); }
console.log('OpenAI Codex');
console.log('ARGS:' + JSON.stringify(process.argv.slice(2)));
if (process.env.LARK_CODING_ASSISTANT_SESSION_ID === 'instant-fail') {
  console.log('failed to acquire thread writer lock');
  process.exit(7);
}
if (process.argv.includes('resume') && !process.argv.includes('--last')) {
  console.log('Resume a previous session');
  console.log('Type to search                   Filter: [Cwd] Sort: [Updated]');
  console.log('  ❯ 3d ago      Previous task');
  console.log('    5d ago      Older task');
  console.log('──────────────────────────────────────────────── 1 / 2 · 100% ─');
  console.log('enter resume   esc new   ctrl+c quit   ↑/↓ browse');
}
const rl = createInterface({ input: process.stdin });
process.stdout.write('› ');
rl.on('line', (line) => {
  console.log('RECEIVED:' + line);
  if (line === 'finish without running') {
    console.log('────────────────────────────────────────────────────────────────');
    console.log('FINAL CONCLUSION WITHOUT WORKED FOR');
    console.log('────────────────────────────────────────────────────────────────');
  }
  process.stdout.write('› ');
});
`);
    await chmod(fakeCodex, 0o755);
    await store.ensure();
    await store.saveConfig({
      tenant: 'feishu', appId: 'cli_test', tmuxBinary: 'tmux',
      agentBinaries: { codex: fakeCodex, 'traex': fakeCodex, 'claude': fakeCodex }, pollIntervalMs: 50,
      workspaceRoots: [],
    });
    await store.saveSecrets({ appSecret: 'test', callbackSecret: 'callback-test' });
    await store.saveState({ schemaVersion: 2, ownerOpenId: 'ou_owner', sessions: {}, updatedAt: Date.now() });
    const fake = new FakeGateway();
    const factory: GatewayFactory = (_config, _secrets, handler) => {
      fake.handler = handler;
      return fake;
    };
    const daemonSessionName = `lca-daemon-test-${process.pid}-${Date.now()}`;
    const daemon = new AssistantDaemon(
      store,
      paths,
      factory,
      daemonSessionName,
      undefined,
      150,
      'test-version',
      3_000,
    );
    await daemon.start();
    const ping = await requestDaemon(paths.socket, { method: 'ping' });
    expect(ping).toEqual({ ok: true, value: { version: 'test-version', pid: process.pid } });
    const duplicateDaemon = new AssistantDaemon(store, paths, factory, `lca-duplicate-${process.pid}-${Date.now()}`);
    await expect(duplicateDaemon.start()).rejects.toThrow(`daemon is already running with PID ${process.pid}`);
    cleanups.push(async () => {
      await requestDaemon(paths.socket, { method: 'stop', sessionId: 'default' }).catch(() => undefined);
      await requestDaemon(paths.socket, { method: 'stop', sessionId: 'second' }).catch(() => undefined);
      await daemon.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });

    const started = await requestDaemon(paths.socket, { method: 'start', cwd: root, sessionId: 'default', agent: 'codex' });
    expect(started.ok).toBe(true);
    expect((started as { ok: true; value: { binding: { mode: string } } }).value.binding.mode).toBe('awaiting-owner-message');
    const duplicateStart = await requestDaemon(paths.socket, {
      method: 'start', cwd: root, sessionId: 'default', agent: 'codex',
    });
    expect(duplicateStart).toMatchObject({
      ok: false,
      error: 'managed coding-agent session is already running: default',
      errorCode: 'SESSION_EXISTS',
      errorContext: { sessionId: 'default' },
    });
    expect(JSON.stringify(duplicateStart)).not.toContain('at AssistantDaemon');
    const instantFailure = await requestDaemon(paths.socket, {
      method: 'start', cwd: root, sessionId: 'instant-fail', agent: 'codex',
    });
    expect(instantFailure).toMatchObject({
      ok: false,
      errorCode: 'AGENT_EXITED_DURING_STARTUP',
      errorContext: { sessionId: 'instant-fail', agent: 'codex' },
    });
    expect([7, undefined]).toContain((instantFailure as { errorContext?: { exitStatus?: number } }).errorContext?.exitStatus);
    expect((instantFailure as { errorContext?: { terminalExcerpt?: string } }).errorContext?.terminalExcerpt)
      .toContain('failed to acquire thread writer lock');
    expect((await store.loadState()).sessions?.['instant-fail']).toBeUndefined();

    const timedOut = await requestDaemon(paths.socket, {
      method: 'start', cwd: root, sessionId: 'timeout', agent: 'traex', resume: { mode: 'last' },
    }, 5_000);
    expect(timedOut).toMatchObject({
      ok: false,
      errorCode: 'SESSION_START_TIMEOUT',
      errorContext: {
        sessionId: 'timeout', agent: 'traex', cwd: root, stage: 'agent-identity', timeoutMs: 3_000,
      },
    });
    expect((await store.loadState()).sessions?.timeout).toBeUndefined();
    expect(await runFile('tmux', ['has-session', '-t', `=${daemonSessionName}-timeout`]).then(() => true, () => false)).toBe(false);
    const timeoutRetry = await requestDaemon(paths.socket, {
      method: 'start', cwd: root, sessionId: 'timeout', agent: 'traex',
    });
    expect(timeoutRetry.ok).toBe(true);
    await requestDaemon(paths.socket, { method: 'stop', sessionId: 'timeout' });

    await fake.emit(message('hello from lark'));
    expect(fake.processingMessages.map(({ content }) => content)).toContain('hello from lark');
    expect(fake.texts.at(-1)?.text).toContain('已自动连接');
    await waitFor(async () => {
      const result = await requestDaemon(paths.socket, { method: 'tail', lines: 40 });
      return result.ok && String(result.value).includes('RECEIVED:hello from lark');
    });
    const processingCount = fake.processingMessages.length;
    await fake.emit(message('/status'));
    expect(fake.processingMessages).toHaveLength(processingCount);
    await fake.emit(message(`/start instant-fail --agent codex --cwd "${root}"`));
    const startupFailure = fake.startupFailures.at(-1);
    expect(startupFailure).toMatchObject({
      sessionId: 'instant-fail', agent: 'codex',
      terminalExcerpt: expect.stringContaining('failed to acquire thread writer lock'),
    });
    expect([7, undefined]).toContain(startupFailure?.exitStatus);
    expect((await store.loadState()).sessions?.['instant-fail']).toBeUndefined();

    await fake.emit(message('/detach'));
    await fake.emit(message('must not auto reconnect after detach'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const detachedTail = await requestDaemon(paths.socket, { method: 'tail', lines: 40 });
    expect(detachedTail.ok && String(detachedTail.value)).not.toContain('must not auto reconnect after detach');

    const rotated = await requestDaemon(paths.socket, { method: 'bindCode' });
    expect(rotated.ok).toBe(true);
    const bindCode = (rotated as { ok: true; value: { bindCode: string } }).value.bindCode;
    await fake.emit(message(`/attach ${bindCode}`));
    expect(fake.texts.at(-1)?.text).toContain('绑定成功');
    await fake.emit(message('/status'));
    expect(fake.statuses.at(-1)).toMatchObject({
      session: { id: 'default', agent: 'codex' },
      paneAlive: true,
      sessions: [{ session: { id: 'default', agent: 'codex' }, paneAlive: true, active: true }],
    });
    await fake.emit(message('/manual'));
    expect(fake.manualViews.at(-1)).toMatchObject({ session: { id: 'default' }, state: 'active' });
    await fake.emit(message('/type manual-'));
    await fake.emit(message('/submit fallback'));
    await waitFor(async () => {
      const result = await requestDaemon(paths.socket, { method: 'tail', lines: 40 });
      return result.ok && String(result.value).includes('RECEIVED:manual-fallback');
    });
    await fake.emit(message('/tail 19'));
    expect(fake.texts.at(-1)?.text).toBe('用法：/tail [20-300]');
    const manualMarkdownCount = fake.markdowns.length;

    const secondStart = requestDaemon(paths.socket, {
      method: 'start', cwd: root, sessionId: 'second', agent: 'traex', resume: { mode: 'last' },
    });
    await waitFor(() => runFile('tmux', ['has-session', '-t', `=${daemonSessionName}-second`])
      .then(() => true, () => false));
    expect((await store.loadState()).sessions?.second).toBeUndefined();
    await requestDaemon(paths.socket, {
      method: 'agentSessionStarted',
      candidate: { sessionId: 'second', agent: 'traex', agentSessionId: 'thread-second', cwd: root, source: 'resume' },
    });
    const second = await secondStart;
    expect(second.ok).toBe(true);
    const secondSession = (await store.loadState()).sessions?.second as ManagedSession;
    await fake.emit(message('/sessions'));
    expect(fake.sessionPickers.at(-1)).toMatchObject({ activeSessionId: 'default' });
    expect(fake.sessionPickers.at(-1)?.sessions.map(({ id }) => id)).toEqual(['default', 'second']);
    await fake.emit(message('/start'));
    expect(fake.sessionCreateChats.at(-1)).toBe('oc_owner');
    const sessionCreateView = fake.sessionCreateViews.at(-1) as SessionCreateView;
    expect(sessionCreateView.candidates.some((candidate) => candidate.cwd === root)).toBe(true);
    fake.failNextSessionPicker = true;
    await fake.emit(message('/sessions'));
    expect(fake.texts.at(-1)?.text).toContain('Session 选择卡片发送失败');
    const switched = await fake.emitSignedAction({
      v: 1,
      kind: 'session',
      agent: 'traex',
      action: 'second',
      paneId: secondSession.paneId,
      fingerprint: String(secondSession.updatedAt),
      chatId: 'oc_owner',
      nonce: 'nonce',
      expiresAt: Date.now() + 60_000,
      sig: 'test',
    });
    expect(switched).toMatchObject({ type: 'success', content: '已连接到 second' });
    expect((await store.loadState()).sessions?.second?.agent).toBe('traex');
    await waitFor(async () => {
      const result = await requestDaemon(paths.socket, { method: 'tail', lines: 40 });
      return result.ok && String(result.value).includes('"resume","--last"');
    });
    await fake.emit(message('hello second session'));
    await waitFor(async () => {
      const result = await requestDaemon(paths.socket, { method: 'tail', lines: 40 });
      return result.ok && String(result.value).includes('RECEIVED:hello second session');
    });
    await fake.emit(message('/use default'));
    expect(fake.texts.at(-1)?.text).toContain('已连接到 codex session：default');
    const stopAction = {
      v: 1 as const, kind: 'session-stop' as const, sessionId: 'second', agent: 'traex' as const,
      action: 'request', paneId: secondSession.paneId, fingerprint: String(secondSession.updatedAt),
      chatId: 'oc_owner', nonce: 'stop-request', expiresAt: Date.now() + 60_000, sig: 'test',
    };
    expect(await fake.emitSignedAction(stopAction)).toMatchObject({
      type: 'session-picker', confirmingStopSessionId: 'second',
    });
    expect(await fake.emitSignedAction({ ...stopAction, action: 'cancel', nonce: 'stop-cancel' })).toMatchObject({
      type: 'session-picker', content: '已取消关闭 second。',
    });
    await fake.emit(message('/start malformed --agent codex'));
    expect(fake.texts.at(-1)?.text).toContain('请提供 --cwd');
    await fake.emit(message(`/start remote --agent claude-code --cwd "${root}"`));
    expect(fake.texts.at(-1)?.text).toContain('已启动并连接 claude session「remote」');
    expect((await store.loadState()).activeSessionId).toBe('remote');
    expect((await store.loadState()).sessions?.remote?.agent).toBe('claude');
    await fake.emit(message('/use default'));
    await requestDaemon(paths.socket, { method: 'stop', sessionId: 'remote' });

    const invalidManual = await fake.emitSignedFormAction({
      v: 1, kind: 'session-create', agent: 'claude', action: 'submit', paneId: '', fingerprint: 'projects',
      chatId: 'oc_owner', nonce: 'form-invalid-manual', expiresAt: Date.now() + 60_000, sig: 'test',
      snapshotId: sessionCreateView.snapshotId, page: sessionCreateView.page,
    }, {
      session_name: 'manual-project', session_agent: 'claude', session_project: '__manual__',
      session_cwd: 'relative/path', session_resume: 'new',
    });
    expect(invalidManual).toMatchObject({
      type: 'error', content: expect.stringContaining('工作目录不可用'),
    });

    const cardCreated = await fake.emitSignedFormAction({
      v: 1, kind: 'session-create', agent: 'codex', action: 'submit', paneId: '', fingerprint: 'projects',
      chatId: 'oc_owner', nonce: 'form-nonce', expiresAt: Date.now() + 60_000, sig: 'test',
      snapshotId: sessionCreateView.snapshotId, page: sessionCreateView.page,
    }, {
      session_name: 'cardremote', session_agent: 'traex', session_project: root, session_resume: 'new',
    });
    expect(cardCreated).toMatchObject({ type: 'session-created', session: { id: 'cardremote', agent: 'traex' } });
    const legacyLast = await fake.emitSignedFormAction({
      v: 1, kind: 'session-create', agent: 'codex', action: 'submit', paneId: '', fingerprint: 'create',
      chatId: 'oc_owner', nonce: 'legacy-last', expiresAt: Date.now() + 60_000, sig: 'test',
    }, {
      session_name: 'legacy-last', session_agent: 'codex', session_cwd: root, session_resume: 'last',
    });
    expect(legacyLast).toMatchObject({
      type: 'error', content: expect.stringContaining('飞书已不再支持“恢复上次会话”'),
    });
    const pickerCreated = await fake.emitSignedFormAction({
      v: 1, kind: 'session-create', agent: 'codex', action: 'submit', paneId: '', fingerprint: 'create',
      chatId: 'oc_owner', nonce: 'picker-form', expiresAt: Date.now() + 60_000, sig: 'test',
    }, {
      session_name: 'pickerremote', session_agent: 'codex', session_cwd: root, session_resume: 'picker',
    });
    expect(pickerCreated).toMatchObject({
      type: 'resume-picker', session: { id: 'pickerremote', agent: 'codex' },
      picker: { options: [{ label: 'Previous task', selected: true }, { label: 'Older task', selected: false }] },
    });
    expect(fake.manualViews.some(({ session }) => session.id === 'pickerremote')).toBe(false);

    const pickerRollback = await fake.emitSignedFormAction({
      v: 1, kind: 'session-create', agent: 'codex', action: 'submit', paneId: '', fingerprint: 'create',
      chatId: 'oc_owner', nonce: 'picker-rollback', expiresAt: Date.now() + 60_000, sig: 'test',
    }, {
      session_name: 'pickerrollback', session_agent: 'codex', session_cwd: root, session_resume: 'picker',
    }) as Extract<LarkActionResult, { type: 'resume-picker' }>;
    expect(pickerRollback).toMatchObject({ type: 'resume-picker', session: { id: 'pickerrollback' } });
    await fake.handler?.onResumePickerDeliveryFailure?.(pickerRollback.session);
    expect((await store.loadState()).sessions?.pickerrollback).toBeUndefined();

    const pickerResult = pickerCreated as Extract<LarkActionResult, { type: 'resume-picker' }>;
    const selectedOption = pickerResult.picker.options[0];
    const pickerSelection = fake.emitSignedAction({
      v: 1, kind: 'resume-picker', sessionId: 'pickerremote', agent: 'codex',
      action: `select:${selectedOption?.id}`, paneId: pickerResult.session.paneId,
      fingerprint: pickerResult.picker.fingerprint, chatId: 'oc_owner', nonce: 'picker-select',
      expiresAt: Date.now() + 60_000, sig: 'test',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await requestDaemon(paths.socket, {
      method: 'agentSessionStarted',
      candidate: { sessionId: 'pickerremote', agent: 'codex', agentSessionId: 'picker-native', cwd: root, source: 'resume' },
    });
    expect(await pickerSelection).toMatchObject({ type: 'session-created', session: { id: 'pickerremote' } });
    await requestDaemon(paths.socket, { method: 'stop', sessionId: 'pickerremote' });
    expect((await store.loadState()).activeSessionId).toBe('default');
    await fake.emit(message('/use default'));
    await requestDaemon(paths.socket, { method: 'stop', sessionId: 'cardremote' });

    const inactiveCompletion = await requestDaemon(paths.socket, {
      method: 'turnComplete',
      candidate: {
        sessionId: 'second', agentSessionId: 'thread-second', eventId: 'turn-second', cwd: root,
        lastAssistantMessage: 'INACTIVE SESSION RESULT',
      },
    });
    expect(inactiveCompletion.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.markdowns).toHaveLength(manualMarkdownCount);

    expect(await fake.emitSignedAction({ ...stopAction, action: 'confirm', nonce: 'stop-confirm' })).toMatchObject({
      type: 'session-picker', content: '已关闭 second。',
    });
    await waitFor(async () => (await store.loadState()).sessions?.second === undefined);
    await fake.emit(message('/sessions'));
    expect(fake.sessionPickers.at(-1)?.sessions.map(({ id }) => id)).toEqual(['default']);
    expect(fake.sessionPickers.at(-1)?.activeSessionId).toBe('default');
    expect((await store.loadState()).sessions?.second).toBeUndefined();

    await fake.emit(message('finish without running'));
    await waitFor(async () => {
      const result = await requestDaemon(paths.socket, { method: 'tail', lines: 40 });
      return result.ok && String(result.value).includes('FINAL CONCLUSION WITHOUT WORKED FOR');
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.markdowns).toHaveLength(manualMarkdownCount);

    const completionCandidate = {
      sessionId: 'default',
      agentSessionId: 'thread-1',
      eventId: 'turn-1',
      cwd: root,
      lastAssistantMessage: 'FINAL CONCLUSION WITHOUT WORKED FOR',
    };
    const notified = await requestDaemon(paths.socket, { method: 'turnComplete', candidate: completionCandidate });
    expect(notified.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(fake.markdowns).toHaveLength(manualMarkdownCount);

    const finalCompletionCandidate = {
      ...completionCandidate,
      eventId: 'turn-2',
      lastAssistantMessage: 'LATEST CONCLUSION AFTER INTERMEDIATE TURN',
    };
    const coalesced = await requestDaemon(paths.socket, { method: 'turnComplete', candidate: finalCompletionCandidate });
    expect(coalesced.ok).toBe(true);
    await waitFor(async () => fake.markdowns.some(({ markdown }) => markdown.includes('LATEST CONCLUSION AFTER INTERMEDIATE TURN')));
    expect(fake.markdowns).toHaveLength(manualMarkdownCount + 1);
    expect(fake.markdowns.at(-1)?.markdown).toContain('codex 等待用户输入');
    expect(fake.markdowns[0]?.markdown).not.toContain('FINAL CONCLUSION WITHOUT WORKED FOR');

    const duplicate = await requestDaemon(paths.socket, { method: 'turnComplete', candidate: finalCompletionCandidate });
    expect(duplicate.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.markdowns).toHaveLength(manualMarkdownCount + 1);

    const stopped = await requestDaemon(paths.socket, { method: 'stop' });
    expect(stopped.ok).toBe(true);
    const restarted = await requestDaemon(paths.socket, { method: 'start', cwd: root, sessionId: 'default', agent: 'codex' });
    expect(restarted.ok).toBe(true);
    expect((restarted as { ok: true; value: { binding: { mode: string } } }).value.binding.mode).toBe('reused');
    const restartedSession = (restarted as { ok: true; value: { session: ManagedSession } }).value.session;
    await runFile('tmux', ['kill-session', '-t', `=${restartedSession.sessionName}`]);
    await waitFor(async () => {
      const state = await store.loadState();
      return state.sessions?.default === undefined && state.activeSessionId === undefined;
    });
    await waitFor(async () => fake.texts.some(({ text }) => text.includes('codex/tmux pane 已退出')));
  }, 45_000);
});

class FakeGateway implements RemoteGateway {
  handler?: LarkGatewayHandler;
  texts: Array<{ chatId: string; text: string }> = [];
  markdowns: Array<{ chatId: string; markdown: string }> = [];
  sessionPickers: Array<{ chatId: string; sessions: ManagedSession[]; activeSessionId?: string }> = [];
  sessionCreateChats: string[] = [];
  sessionCreateViews: SessionCreateView[] = [];
  statuses: Array<RuntimeStatus> = [];
  manualViews: ManualControlView[] = [];
  startupFailures: SessionStartupFailure[] = [];
  processingMessages: NormalizedMessage[] = [];
  failNextSessionPicker = false;
  connect = async (): Promise<void> => undefined;
  disconnect = async (): Promise<void> => undefined;
  startProcessing = async (value: NormalizedMessage): Promise<void> => { this.processingMessages.push(value); };
  sendText = async (chatId: string, text: string): Promise<void> => { this.texts.push({ chatId, text }); };
  sendMarkdown = async (chatId: string, markdown: string): Promise<void> => { this.markdowns.push({ chatId, markdown }); };
  sendChoice = async (_chatId: string, _paneId: string, _screen: ScreenDetection): Promise<void> => undefined;
  updateChoice = async (_messageId: string, _chatId: string, _paneId: string, _screen: ScreenDetection): Promise<void> => undefined;
  completeChoiceInput = async (): Promise<void> => undefined;
  sendManual = async (_chatId: string, view: ManualControlView): Promise<void> => { this.manualViews.push(view); };
  sendStatus = async (_chatId: string, status: RuntimeStatus): Promise<void> => { this.statuses.push(status); };
  sendSessionPicker = async (chatId: string, sessions: ManagedSession[], activeSessionId?: string): Promise<void> => {
    if (this.failNextSessionPicker) {
      this.failNextSessionPicker = false;
      throw new Error('invalid card payload');
    }
    this.sessionPickers.push({ chatId, sessions, activeSessionId });
  };
  sendResumePicker = async (): Promise<void> => undefined;
  sendStartupConflict = async (): Promise<void> => undefined;
  sendSessionCreate = async (chatId: string, view: SessionCreateView): Promise<void> => {
    this.sessionCreateChats.push(chatId);
    this.sessionCreateViews.push(view);
  };
  sendSessionStartupFailure = async (_chatId: string, failure: SessionStartupFailure): Promise<void> => {
    this.startupFailures.push(failure);
  };
  sendStopConfirmation = async (): Promise<void> => undefined;
  emit(value: NormalizedMessage): Promise<void> {
    if (!this.handler) throw new Error('gateway not connected');
    return this.handler.onMessage(value);
  }
  emitAction(event: CardActionEvent): Promise<unknown> {
    if (!this.handler) throw new Error('gateway not connected');
    return this.handler.onAction(event, event.action.value as never);
  }
  emitSignedAction(action: SignedAction): Promise<unknown> {
    if (!this.handler) throw new Error('gateway not connected');
    return this.handler.onAction({ operator: { openId: 'ou_owner' }, chatId: 'oc_owner' } as CardActionEvent, action);
  }
  emitSignedFormAction(action: SignedAction, formValue: Record<string, unknown>): Promise<unknown> {
    if (!this.handler) throw new Error('gateway not connected');
    return this.handler.onAction({
      operator: { openId: 'ou_owner' }, chatId: 'oc_owner', messageId: 'om_form',
      action: { formValue },
    } as CardActionEvent, action);
  }
}

let messageSequence = 0;

function message(content: string): NormalizedMessage {
  return {
    messageId: `om_${Date.now()}_${++messageSequence}`,
    chatId: 'oc_owner',
    chatType: 'p2p',
    senderId: 'ou_owner',
    senderType: 'user',
    senderIsBot: false,
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}

async function hasTmux(): Promise<boolean> {
  return runFile('tmux', ['-V']).then(() => true, () => false);
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for bridge output');
}
