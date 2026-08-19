import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { AssistantDaemon } from '../../src/daemon/server.js';
import { requestDaemon } from '../../src/daemon/client.js';
import { resolveAppPaths } from '../../src/core/paths.js';
import { AppStore } from '../../src/core/store.js';
import type { GatewayFactory, LarkGatewayHandler, RemoteGateway } from '../../src/lark/gateway.js';
import type { ManagedSession } from '../../src/core/model.js';
import type { SignedAction } from '../../src/lark/action-signing.js';
import type { ScreenDetection } from '../../src/screen/detector.js';
import type { RuntimeStatus } from '../../src/daemon/protocol.js';
import type { ManualControlView } from '../../src/lark/cards.js';
import { runFile } from '../../src/platform/process.js';

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
      agentBinaries: { codex: fakeCodex, 'trae-cli': fakeCodex, 'claude-code': fakeCodex }, pollIntervalMs: 50,
    });
    await store.saveSecrets({ appSecret: 'test', callbackSecret: 'callback-test' });
    await store.saveState({ schemaVersion: 2, ownerOpenId: 'ou_owner', sessions: {}, updatedAt: Date.now() });
    const fake = new FakeGateway();
    const factory: GatewayFactory = (_config, _secrets, handler) => {
      fake.handler = handler;
      return fake;
    };
    const daemon = new AssistantDaemon(
      store,
      paths,
      factory,
      `lca-daemon-test-${process.pid}-${Date.now()}`,
      undefined,
      150,
      'test-version',
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

    await fake.emit(message('hello from lark'));
    expect(fake.texts.at(-1)?.text).toContain('已自动连接');
    await waitFor(async () => {
      const result = await requestDaemon(paths.socket, { method: 'tail', lines: 40 });
      return result.ok && String(result.value).includes('RECEIVED:hello from lark');
    });

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
    expect(fake.statuses.at(-1)).toMatchObject({ session: { id: 'default', agent: 'codex' }, paneAlive: true });
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

    const second = await requestDaemon(paths.socket, {
      method: 'start', cwd: root, sessionId: 'second', agent: 'trae-cli', resume: { mode: 'last' },
    });
    expect(second.ok).toBe(true);
    const secondSession = (second as { ok: true; value: { session: ManagedSession } }).value.session;
    await fake.emit(message('/sessions'));
    expect(fake.sessionPickers.at(-1)).toMatchObject({ activeSessionId: 'default' });
    expect(fake.sessionPickers.at(-1)?.sessions.map(({ id }) => id)).toEqual(['default', 'second']);
    fake.failNextSessionPicker = true;
    await fake.emit(message('/sessions'));
    expect(fake.texts.at(-1)?.text).toContain('Session 选择卡片发送失败');
    const switched = await fake.emitSignedAction({
      v: 1,
      kind: 'session',
      agent: 'trae-cli',
      action: 'second',
      paneId: secondSession.paneId,
      fingerprint: String(secondSession.updatedAt),
      chatId: 'oc_owner',
      nonce: 'nonce',
      expiresAt: Date.now() + 60_000,
      sig: 'test',
    });
    expect(switched).toMatchObject({ type: 'success', content: '已连接到 second' });
    expect((await store.loadState()).sessions?.second?.agent).toBe('trae-cli');
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
    expect(fake.texts.at(-1)?.text).toContain('已连接到 Codex session：default');

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

    await runFile('tmux', ['kill-session', '-t', `=${secondSession.sessionName}`]);
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
    expect(fake.markdowns.at(-1)?.markdown).toContain('Codex 等待用户输入');
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
    await waitFor(async () => fake.texts.some(({ text }) => text.includes('Codex/tmux pane 已退出')));
  }, 10_000);
});

class FakeGateway implements RemoteGateway {
  handler?: LarkGatewayHandler;
  texts: Array<{ chatId: string; text: string }> = [];
  markdowns: Array<{ chatId: string; markdown: string }> = [];
  sessionPickers: Array<{ chatId: string; sessions: ManagedSession[]; activeSessionId?: string }> = [];
  statuses: Array<RuntimeStatus> = [];
  manualViews: ManualControlView[] = [];
  failNextSessionPicker = false;
  connect = async (): Promise<void> => undefined;
  disconnect = async (): Promise<void> => undefined;
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
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om_${Date.now()}`,
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
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for bridge output');
}
