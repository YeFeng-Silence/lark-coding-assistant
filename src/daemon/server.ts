import { appendFile, chmod, open, readFile, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { basename } from 'node:path';
import { runFile } from '../platform/process.js';
import type { ScreenDetection } from '../screen/detector.js';
import { tailScreen } from '../screen/normalize.js';
import { AppStore, createBindCode, hashBindCode } from '../core/store.js';
import type { AppConfig, ManagedSession, SessionState } from '../core/model.js';
import type { AppPaths } from '../core/paths.js';
import { AppError, serializeAppError } from '../core/errors.js';
import { TmuxController } from '../tmux/controller.js';
import type { DaemonRequest, DaemonResult, RuntimeStatus } from './protocol.js';
import { getAgentAdapter } from '../agents/registry.js';
import type { AgentId, AgentResume, TurnCompleteCandidate } from '../agents/types.js';
import { validTurnCompleteCandidate } from '../agents/stop-event.js';
import { LarkGateway, type GatewayFactory, type LarkActionResult, type RemoteGateway } from '../lark/gateway.js';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import type { SignedAction } from '../lark/action-signing.js';
import { verifyBindCode } from '../core/store.js';
import {
  CHOICE_FORM_SUBMIT_ACTION,
  MANUAL_TEXT_FIELD,
  choiceFormFieldName,
  inlineInputName,
  type ManualControlState,
  type ManualControlView,
} from '../lark/cards.js';

export class AssistantDaemon {
  private config!: AppConfig;
  private state!: SessionState;
  private tmux!: TmuxController;
  private screen?: ScreenDetection;
  private previousScreen?: ScreenDetection;
  private readonly completedEvents = new Set<string>();
  private pendingCompletion?: TurnCompleteCandidate;
  private pendingCompletionAt = 0;
  private outputStableSince = Date.now();
  private timer?: NodeJS.Timeout;
  private pollInFlight?: Promise<void>;
  private ownsRuntimeFiles = false;
  private closing = false;
  private gateway?: RemoteGateway;
  private readonly pendingMessages: string[] = [];
  private interactionNotificationsSuppressed = 0;
  private unresolvedCandidate?: { key: string; since: number };
  private readonly unresolvedNotified = new Set<string>();
  private readonly closedManualCards = new Set<string>();
  private pendingInteractionInput?: {
    sessionId: string;
    interactionId: string;
    controlId: string;
    role: 'custom-input' | 'chat';
    label: string;
    cardMessageId: string;
    submitOnInput: boolean;
    action: SignedAction;
  };
  private readonly attachAttempts = new Map<string, number[]>();
  private server = createServer((socket) => this.handleSocket(socket));

  constructor(
    private readonly store: AppStore,
    private readonly paths: AppPaths,
    private readonly gatewayFactory: GatewayFactory = (config, secrets, handler) => new LarkGateway(config, secrets, handler),
    private readonly sessionName = 'lark-coding-assistant',
    private readonly stopHookCommand = 'lark-coding-assistant-hook',
    private readonly completionQuietMs = 2_500,
    private readonly appVersion = 'dev',
  ) {}

  async start(): Promise<void> {
    await this.store.ensure();
    const config = await this.store.loadConfig();
    if (!config) throw new Error('not initialized; run lark-coding-assistant init first');
    this.config = config;
    this.state = await this.store.loadState();
    this.tmux = new TmuxController(config.tmuxBinary);
    const secrets = await this.store.loadSecrets();
    if (!secrets) throw new Error('missing secrets; run lark-coding-assistant init again');
    await this.acquireRuntimeFiles();
    try {
      await this.reconcileSessions();
      await rm(this.paths.socket, { force: true });
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.paths.socket, () => resolve());
      });
      await chmod(this.paths.socket, 0o600);
      this.gateway = this.gatewayFactory(config, secrets, {
        onMessage: (message) => this.onLarkMessage(message),
        onAction: (event, action) => this.onLarkAction(event, action),
      });
      await this.gateway.connect();
      this.schedulePoll();
      await this.log('daemon started');
    } catch (error) {
      await this.releaseRuntimeFiles();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.log('daemon stopping').catch(() => undefined);
    if (this.timer) clearTimeout(this.timer);
    await this.pollInFlight?.catch(() => undefined);
    await this.gateway?.disconnect().catch(() => undefined);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.releaseRuntimeFiles();
  }

  private async acquireRuntimeFiles(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const pidFile = await open(this.paths.pid, 'wx', 0o600);
        try {
          await pidFile.writeFile(`${process.pid}\n`);
        } finally {
          await pidFile.close();
        }
        this.ownsRuntimeFiles = true;
        return;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const existingPid = Number.parseInt(await readFile(this.paths.pid, 'utf8').catch(() => ''), 10);
        if (Number.isInteger(existingPid) && processIsAlive(existingPid)) {
          throw new Error(`daemon is already running with PID ${existingPid}`);
        }
        await rm(this.paths.pid, { force: true });
      }
    }
    throw new Error('failed to acquire daemon PID file');
  }

  private async releaseRuntimeFiles(): Promise<void> {
    if (!this.ownsRuntimeFiles) return;
    const ownerPid = Number.parseInt(await readFile(this.paths.pid, 'utf8').catch(() => ''), 10);
    if (ownerPid === process.pid) {
      await Promise.all([rm(this.paths.socket, { force: true }), rm(this.paths.pid, { force: true })]);
    }
    this.ownsRuntimeFiles = false;
  }

  private handleSocket(socket: Socket): void {
    socket.setEncoding('utf8');
    let buffer = '';
    let dispatched = false;
    socket.on('data', (chunk) => {
      if (dispatched) return;
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      dispatched = true;
      const line = buffer.slice(0, newline);
      void Promise.resolve()
        .then(() => JSON.parse(line) as DaemonRequest)
        .then((request) => this.dispatch(request))
        .then((response) => socket.end(`${JSON.stringify(response)}\n`))
        .catch((error) => socket.end(`${JSON.stringify(fail(error))}\n`));
    });
    socket.on('end', () => {
      if (!dispatched) socket.end();
    });
  }

  private async dispatch(request: DaemonRequest): Promise<DaemonResult> {
    switch (request.method) {
      case 'ping': return { ok: true, value: { version: this.appVersion, pid: process.pid } };
      case 'shutdown': {
        setTimeout(() => void this.close(), 25);
        return { ok: true };
      }
      case 'start': return this.startSession(request.sessionId, request.cwd, request.agent, request.resume);
      case 'status': return { ok: true, value: await this.runtimeStatus(request.sessionId) };
      case 'tail': return { ok: true, value: await this.tail(request.lines ?? 80) };
      case 'send': return this.send(request.text);
      case 'key': return this.key(request.key, request.fingerprint);
      case 'stop': return this.stopSession(request.sessionId);
      case 'useSession': return this.useSession(request.sessionId);
      case 'bindCode': return this.rotateBindCode();
      case 'resetOwner': return this.resetOwner();
      case 'turnComplete': return this.handleTurnComplete(request.candidate);
    }
  }

  private async startSession(
    sessionId: string,
    cwd: string,
    agentId: AgentId,
    resume?: AgentResume,
  ): Promise<DaemonResult> {
    if (!validSessionId(sessionId)) {
      return fail(new AppError(
        'INVALID_SESSION_NAME',
        'session name must use letters, digits, underscore, or dash',
        { sessionId },
      ));
    }
    const existing = this.state.sessions?.[sessionId];
    if (existing && await this.tmux.inspect(existing.paneId)) {
      return fail(new AppError(
        'SESSION_EXISTS',
        `managed coding-agent session is already running: ${sessionId}`,
        { sessionId },
      ));
    }
    const becomesActive = !this.state.activeSessionId;
    if (becomesActive) {
      this.pendingMessages.length = 0;
      this.previousScreen = undefined;
      this.completedEvents.clear();
      this.clearPendingCompletion();
    }
    const adapter = getAgentAdapter(agentId);
    const binary = adapter.binary(this.config);
    const agentVersion = (await runFile(binary, [...adapter.versionArgs])).stdout.trim();
    const tmuxSessionName = existing?.sessionName ?? `${this.sessionName}-${sessionId}`;
    const pane = await this.tmux.create({
      sessionName: tmuxSessionName,
      cwd,
      binary,
      args: adapter.buildLaunchArgs({
        resume,
        stopHookCommand: this.stopHookCommand,
      }),
      env: {
        LARK_CODING_ASSISTANT_SOCKET: this.paths.socket,
        LARK_CODING_ASSISTANT_SESSION_ID: sessionId,
      },
    });
    const binding = this.createSessionBinding();
    const session: ManagedSession = {
      id: sessionId,
      agent: agentId,
      sessionName: pane.sessionName,
      paneId: pane.paneId,
      cwd,
      agentVersion,
      updatedAt: Date.now(),
    };
    this.state = {
      ...this.state,
      sessions: { ...this.state.sessions, [sessionId]: session },
      activeSessionId: this.state.activeSessionId ?? sessionId,
      boundChatId: binding.mode === 'reused' ? this.state.boundChatId : undefined,
      bindCodeHash: binding.mode === 'code' ? hashBindCode(binding.bindCode) : undefined,
      bindCodeExpiresAt: binding.mode === 'code' ? Date.now() + 10 * 60_000 : undefined,
      updatedAt: Date.now(),
    };
    await this.store.saveState(this.state);
    await this.poll();
    return { ok: true, value: { pane, session, binding, active: this.state.activeSessionId === sessionId } };
  }

  private createSessionBinding():
    | { mode: 'reused' }
    | { mode: 'awaiting-owner-message' }
    | { mode: 'code'; bindCode: string; expiresInSeconds: number } {
    if (this.state.ownerOpenId && this.state.boundChatId && !this.state.autoBindDisabled) {
      return { mode: 'reused' };
    }
    if (this.state.ownerOpenId && !this.state.autoBindDisabled) {
      return { mode: 'awaiting-owner-message' };
    }
    return { mode: 'code', bindCode: createBindCode(), expiresInSeconds: 600 };
  }

  private async runtimeStatus(sessionId = this.state.activeSessionId): Promise<RuntimeStatus> {
    const session = sessionId ? this.state.sessions?.[sessionId] : undefined;
    const pane = session ? await this.tmux.inspect(session.paneId) : undefined;
    return { state: this.state, session, screen: sessionId === this.state.activeSessionId ? this.screen : undefined, paneAlive: Boolean(pane && !pane.dead) };
  }

  private async tail(lines: number): Promise<string> {
    const session = this.activeSession();
    if (!session) throw new Error('no active managed session');
    return tailScreen(await this.tmux.capture(session.paneId, lines), lines);
  }

  private async send(text: string): Promise<DaemonResult> {
    const session = this.activeSession();
    if (!session) return { ok: false, error: 'no active managed session' };
    await this.poll();
    if (this.screen?.state === 'approval') return { ok: false, error: 'approval is pending' };
    if (this.screen?.hasDraftInput) return { ok: false, error: 'local draft input detected' };
    if (!this.screen || this.screen.state === 'unknown') return { ok: false, error: 'screen state is unknown' };
    this.clearPendingCompletion();
    await this.tmux.sendText(session.paneId, text);
    return { ok: true };
  }

  private async onLarkMessage(message: NormalizedMessage): Promise<void> {
    if (message.chatType !== 'p2p' || message.senderIsBot || message.senderType === 'bot') return;
    const text = message.content.trim();
    const attachCode = text.match(/^\/attach\s+([^\s]+)\s*$/)?.[1];
    if (!this.state.boundChatId) {
      if (this.canAutoBind(message)) {
        await this.bindChat(message, true);
      } else {
        if (!attachCode) return;
        await this.handleAttach(message, attachCode);
        return;
      }
    }
    if (message.senderId !== this.state.ownerOpenId || message.chatId !== this.state.boundChatId) return;

    const tailMatch = text.match(/^\/tail(?:\s+(\d+))?$/);
    if (tailMatch) {
      const lines = tailMatch[1] ? Number(tailMatch[1]) : 80;
      if (!Number.isInteger(lines) || lines < 20 || lines > 300) {
        await this.gateway?.sendText(message.chatId, '用法：/tail [20-300]');
        return;
      }
      const output = await this.tail(lines).catch((error) => `读取失败：${errorMessage(error)}`);
      const session = this.activeSession();
      const metadata = session
        ? `**${session.id} · ${getAgentAdapter(session.agent).displayName}**  ·  状态 \`${this.screen?.state ?? 'unknown'}\`  ·  ${manualTimestamp()}`
        : '**当前没有 active session**';
      await this.gateway?.sendMarkdown(message.chatId, `${metadata}\n\n\`\`\`text\n${escapeFence(output).slice(-6800)}\n\`\`\``);
      return;
    }
    if (text.startsWith('/tail')) {
      await this.gateway?.sendText(message.chatId, '用法：/tail [20-300]');
      return;
    }
    if (text === '/manual') {
      await this.poll();
      const view = this.currentManualView();
      if (!view) await this.gateway?.sendText(message.chatId, '当前没有可遥控的 active tmux session。');
      else {
        try {
          await this.gateway?.sendManual(message.chatId, view);
        } catch (error) {
          await this.log(`manual card failed: ${errorMessage(error)}`);
          await this.gateway?.sendText(
            message.chatId,
            '手动遥控卡发送失败。可使用 /tail 120 查看终端，或使用 /key、/type、/submit 操作。',
          );
        }
      }
      return;
    }
    const manualKey = text.match(/^\/key\s+(up|down|left|right|enter|esc|tab|space|backspace|ctrl-c)$/i)?.[1];
    if (manualKey) {
      await this.executeManualCommand(message.chatId, `按键 ${manualKey}`, async (session) => {
        await this.tmux.sendKey(session.paneId, manualTmuxKey(manualKey));
      });
      return;
    }
    if (text.startsWith('/key')) {
      await this.gateway?.sendText(message.chatId, '用法：/key up|down|left|right|enter|esc|tab|space|backspace|ctrl-c');
      return;
    }
    const typeMatch = text.match(/^\/(type|submit)\s+([\s\S]+)$/);
    if (typeMatch?.[1] && typeMatch[2]?.trim()) {
      const submit = typeMatch[1] === 'submit';
      await this.executeManualCommand(message.chatId, submit ? '输入并提交' : '仅输入', async (session) => {
        await this.tmux.sendText(session.paneId, typeMatch[2] as string, submit);
      });
      return;
    }
    if (text === '/type' || text === '/submit') {
      await this.gateway?.sendText(message.chatId, `用法：${text} <文本>`);
      return;
    }
    if (text === '/status') {
      const status = await this.runtimeStatus();
      await this.gateway?.sendStatus(message.chatId, status);
      return;
    }
    if (text === '/sessions') {
      const sessions = await this.reconcileSessions();
      try {
        await this.gateway?.sendSessionPicker(
          message.chatId,
          sessions,
          this.state.activeSessionId,
        );
      } catch (error) {
        await this.log(`session picker notification failed: ${errorMessage(error)}`);
        await this.gateway?.sendText(
          message.chatId,
          'Session 选择卡片发送失败，请稍后重试；也可以发送 /use <session 名称> 进行切换。',
        );
      }
      return;
    }
    const useSessionId = text.match(/^\/use\s+([a-zA-Z0-9_-]+)\s*$/)?.[1];
    if (useSessionId) {
      const result = await this.useSession(useSessionId);
      const target = this.state.sessions?.[useSessionId];
      const reply = result.ok
        ? `已连接到 ${target ? getAgentAdapter(target.agent).displayName : 'coding agent'} session：${useSessionId}`
        : `切换失败：${result.error}`;
      await this.gateway?.sendText(
        message.chatId,
        reply,
      );
      return;
    }
    if (text === '/detach') {
      this.pendingMessages.length = 0;
      this.pendingInteractionInput = undefined;
      this.unresolvedCandidate = undefined;
      this.unresolvedNotified.clear();
      this.state = {
        ...this.state,
        boundChatId: undefined,
        autoBindDisabled: true,
        updatedAt: Date.now(),
      };
      await this.store.saveState(this.state);
      await this.gateway?.sendText(message.chatId, '已解除本次飞书绑定；coding agent 和 tmux 仍在运行。');
      return;
    }
    if (text === '/stop') {
      await this.poll();
      const session = this.activeSession();
      if (!session || !this.screen) {
        await this.gateway?.sendText(message.chatId, '当前没有可停止的 coding agent 会话。');
      } else {
        await this.gateway?.sendStopConfirmation(message.chatId, session.paneId, this.screen.fingerprint, session.agent);
      }
      return;
    }

    const pendingInput = this.pendingInteractionInput;
    if (pendingInput) {
      const session = this.activeSession();
      if (!session || session.id !== pendingInput.sessionId) {
        this.pendingInteractionInput = undefined;
        await this.gateway?.sendText(message.chatId, '交互会话已经变化，请重新操作。');
        return;
      }
      await this.tmux.sendText(session.paneId, message.content, pendingInput.submitOnInput);
      this.pendingInteractionInput = undefined;
      if (pendingInput.submitOnInput) {
        await this.waitForInteractionChange(pendingInput.interactionId);
        if (this.screen?.interaction?.interactionId === pendingInput.interactionId) {
          await this.gateway?.sendText(message.chatId, '补充内容已输入，但终端仍停留在原问题，请用 /tail 检查。');
          return;
        }
        const content = `已向 ${getAgentAdapter(session.agent).displayName} 提交补充内容。`;
        await this.gateway?.completeChoiceInput(pendingInput.cardMessageId, pendingInput.action, content);
        await this.flushPending();
        return;
      }
      if (pendingInput.role === 'custom-input') {
        const refreshed = await this.withInteractionNotificationsSuppressed(async () => {
          await this.waitForCustomInputValue(pendingInput.interactionId, pendingInput.controlId, message.content);
          const current = this.screen;
          if (current?.interaction?.semantics && (current.interaction.actionConfidence ?? 0) >= 0.85) {
            await this.gateway?.updateChoice(
              pendingInput.cardMessageId,
              message.chatId,
              session.paneId,
              current,
              session.agent,
            );
            return true;
          }
          return false;
        });
        if (refreshed) return;
      }
      await this.gateway?.sendText(message.chatId, `已向 ${getAgentAdapter(session.agent).displayName} 提交补充内容。`);
      return;
    }

    await this.poll();
    if (this.shouldQueueMessage()) {
      if (this.pendingMessages.length >= 100) {
        await this.gateway?.sendText(message.chatId, '待发送队列已满，请先处理当前终端状态。');
        return;
      }
      this.pendingMessages.push(message.content);
      await this.gateway?.sendText(message.chatId, `当前终端暂不可安全写入，消息已排队（${this.pendingMessages.length} 条）。`);
      return;
    }
    const result = await this.send(message.content);
    if (!result.ok) await this.gateway?.sendText(message.chatId, `未发送：${result.error}`);
  }

  private async handleAttach(message: NormalizedMessage, code: string): Promise<void> {
    if (this.state.ownerOpenId && message.senderId !== this.state.ownerOpenId) return;
    if (!this.allowAttachAttempt(message.senderId)) return;
    const valid = Boolean(
      this.state.bindCodeHash
      && this.state.bindCodeExpiresAt
      && this.state.bindCodeExpiresAt >= Date.now()
      && verifyBindCode(code, this.state.bindCodeHash),
    );
    if (!valid) {
      await this.gateway?.sendText(message.chatId, '绑定失败：绑定码无效或已过期。');
      return;
    }
    await this.bindChat(message, false);
  }

  private canAutoBind(message: NormalizedMessage): boolean {
    return !this.state.autoBindDisabled
      && Boolean(this.state.ownerOpenId)
      && message.senderId === this.state.ownerOpenId;
  }

  private async bindChat(message: NormalizedMessage, automatic: boolean): Promise<void> {
    this.state = {
      ...this.state,
      ownerOpenId: this.state.ownerOpenId ?? message.senderId,
      boundChatId: message.chatId,
      autoBindDisabled: false,
      bindCodeHash: undefined,
      bindCodeExpiresAt: undefined,
      updatedAt: Date.now(),
    };
    await this.store.saveState(this.state);
    await this.gateway?.sendText(
      message.chatId,
      automatic
        ? '已自动连接当前 coding agent 会话。之后直接发送普通消息即可。'
        : '绑定成功。之后的普通消息会发送到当前 tmux 中的 coding agent；可用 /tail、/status、/sessions、/detach、/stop。',
    );
    this.previousScreen = undefined;
    await this.poll();
  }

  private allowAttachAttempt(senderId: string): boolean {
    const cutoff = Date.now() - 60_000;
    const attempts = (this.attachAttempts.get(senderId) ?? []).filter((time) => time >= cutoff);
    if (attempts.length >= 5) return false;
    attempts.push(Date.now());
    this.attachAttempts.set(senderId, attempts);
    return true;
  }

  private shouldQueueMessage(): boolean {
    return !this.screen
      || this.screen.state === 'approval'
      || this.screen.state === 'unknown'
      || this.screen.state === 'failed'
      || this.screen.state === 'exited'
      || this.screen.hasDraftInput;
  }

  private async onLarkAction(
    event: CardActionEvent,
    action: SignedAction,
  ): Promise<LarkActionResult> {
    if (event.operator.openId !== this.state.ownerOpenId || event.chatId !== this.state.boundChatId) {
      return { type: 'error', content: '无权操作当前会话。' };
    }
    if (action.kind === 'session') {
      const target = this.state.sessions?.[action.action];
      if (!target
        || target.agent !== action.agent
        || target.paneId !== action.paneId
        || String(target.updatedAt) !== action.fingerprint) {
        return { type: 'error', content: '目标 session 已变化，请重新发送 /sessions。' };
      }
      const result = await this.useSession(target.id);
      return result.ok
        ? { type: 'success', content: `已连接到 ${target.id}` }
        : { type: 'error', content: result.error };
    }
    if (action.kind === 'manual') {
      return this.withInteractionNotificationsSuppressed(() => this.handleManualAction(action, event));
    }
    await this.poll();
    const session = this.activeSession();
    if (action.kind === 'choice') {
      return this.withInteractionNotificationsSuppressed(() => this.handleChoiceAction(action, session, event));
    }
    if (action.paneId !== session?.paneId || action.agent !== session.agent || action.fingerprint !== this.screen?.fingerprint) {
      return { type: 'error', content: '会话画面已变化，请重新发送 /stop。' };
    }
    const result = await this.stopSession(session.id);
    return result.ok
      ? { type: 'success', content: `${getAgentAdapter(session.agent).displayName} 会话已停止。` }
      : { type: 'error', content: result.error };
  }

  private async handleManualAction(action: SignedAction, event: CardActionEvent): Promise<LarkActionResult> {
    await this.poll();
    const session = this.activeSession();
    const screen = this.screen;
    if (!session || !screen || action.sessionId !== session.id || action.agent !== session.agent || action.paneId !== session.paneId) {
      return { type: 'error', content: '手动遥控对应的 session 已变化，请重新发送 /manual。' };
    }
    if (this.closedManualCards.has(event.messageId)) {
      return {
        type: 'manual', content: '该手动遥控卡已经结束。',
        view: this.manualView(session, screen, 'exited', undefined, '结束遥控', action.manualMode),
      };
    }
    if (action.action !== 'refresh' && action.fingerprint !== screen.fingerprint) {
      return {
        type: 'manual', content: '终端画面已变化，旧操作未执行。',
        view: this.manualView(session, screen, 'stale', '请确认最新终端画面后重试。', undefined, action.manualMode),
      };
    }
    if (action.action === 'exit') {
      remember(this.closedManualCards, event.messageId, 256);
      return {
        type: 'manual', content: '已结束手动遥控。',
        view: this.manualView(session, screen, 'exited', undefined, '结束遥控', action.manualMode),
      };
    }
    let operation = '刷新终端输出';
    try {
      if (action.action === 'type' || action.action === 'submit') {
        const value = event.action.formValue?.[MANUAL_TEXT_FIELD];
        if (typeof value !== 'string' || !value.trim()) return { type: 'error', content: '请输入要发送到终端的文本。' };
        const submit = action.action === 'submit';
        operation = submit ? '输入文本并提交' : '仅输入文本';
        await this.tmux.sendText(session.paneId, value, submit);
      } else if (action.action !== 'refresh') {
        const key = manualTmuxKey(action.action);
        operation = `按键 ${action.action}`;
        await this.tmux.sendKey(session.paneId, key);
      }
      if (action.action === 'refresh') await this.poll();
      else await this.settleManualScreen();
    } catch (error) {
      await this.poll().catch(() => undefined);
      const current = this.screen ?? screen;
      return {
        type: 'manual', content: '手动操作失败。',
        view: this.manualView(session, current, 'error', errorMessage(error), operation, action.manualMode),
      };
    }
    const current = this.screen ?? screen;
    if (action.manualMode !== 'explicit' && safeStructuredInteraction(current)) {
      await this.gateway?.sendChoice(event.chatId, session.paneId, current, session.agent);
      return {
        type: 'manual', content: '已恢复结构化识别。',
        view: this.manualView(session, current, 'recovered', undefined, operation, action.manualMode),
      };
    }
    return {
      type: 'manual', content: `${operation}已执行。`,
      view: this.manualView(session, current, 'active', undefined, operation, action.manualMode),
    };
  }

  private currentManualView(): ManualControlView | undefined {
    const session = this.activeSession();
    if (!session || !this.screen || this.screen.state === 'exited') return undefined;
    return this.manualView(session, this.screen, 'active', undefined, undefined, 'explicit');
  }

  private async settleManualScreen(): Promise<void> {
    let previousFingerprint: string | undefined;
    const deadline = Date.now() + 900;
    do {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await this.poll();
      const fingerprint = this.screen?.fingerprint;
      if (fingerprint && fingerprint === previousFingerprint) return;
      previousFingerprint = fingerprint;
    } while (Date.now() < deadline);
  }

  private manualView(
    session: ManagedSession,
    screen: ScreenDetection,
    state: ManualControlState = 'active',
    notice?: string,
    lastOperation?: string,
    mode: ManualControlView['mode'] = 'fallback',
  ): ManualControlView {
    return {
      session,
      screen,
      output: tailScreen(screen.normalized, 40),
      capturedAt: new Date(),
      state,
      notice,
      lastOperation,
      mode,
    };
  }

  private async executeManualCommand(
    chatId: string,
    operation: string,
    execute: (session: ManagedSession) => Promise<void>,
  ): Promise<void> {
    await this.poll();
    const session = this.activeSession();
    if (!session || !this.screen || this.screen.state === 'exited') {
      await this.gateway?.sendText(chatId, '当前没有可遥控的 active tmux session。');
      return;
    }
    try {
      await execute(session);
      await new Promise((resolve) => setTimeout(resolve, 120));
      await this.poll();
      const output = this.screen ? tailScreen(this.screen.normalized, 60) : '无法读取最新终端画面。';
      await this.gateway?.sendMarkdown(chatId, `**手动操作：${operation}**\n\n\`\`\`text\n${escapeFence(output).slice(-6500)}\n\`\`\``);
    } catch (error) {
      await this.gateway?.sendText(chatId, `手动操作失败：${errorMessage(error)}`);
    }
  }

  private async handleChoiceAction(action: SignedAction, session: ManagedSession | undefined, event: CardActionEvent): Promise<LarkActionResult> {
    if (action.paneId !== session?.paneId || action.agent !== session.agent) return { type: 'error', content: '会话已变化。' };
    if (event.action.formValue) {
      if (action.action !== CHOICE_FORM_SUBMIT_ACTION) return { type: 'error', content: '无法识别该表单操作，请使用最新卡片。' };
      return this.handleToggleFormSubmit(action, session, event.action.formValue);
    }
    const before = this.screen?.interaction;
    const target = this.screen?.actions.find(({ key }) => key === action.action);
    const fingerprint = before?.revision ?? this.screen?.fingerprint ?? action.fingerprint;
    const customAlreadySelected = target?.role === 'custom-input'
      && (target.marker === 'checked' || target.marker === 'selected')
      && fingerprint === action.fingerprint
      && before?.kind === action.interactionKind;
    const opensEditor = target?.role === 'custom-input' && target.editor;
    let result: DaemonResult;
    if (customAlreadySelected) {
      result = { ok: true, value: `继续填写：${target.label}` };
    } else if (opensEditor && before?.interactionId) {
      const navigation = await this.navigateToControl(session.paneId, target.id, before.interactionId);
      if (!navigation.ok) return { type: 'error', content: navigation.error };
      if (opensEditor.openKey) await this.tmux.sendKey(session.paneId, opensEditor.openKey);
      result = { ok: true, value: `继续填写：${target.label}` };
    } else {
      result = await this.submitChoice(action.action, fingerprint, action.interactionKind);
    }
    if (!result.ok) return { type: 'error', content: result.error };
    if (before?.semantics?.activation === 'toggle' && target?.role === 'answer') {
      await this.waitForControlMarker(before.interactionId, target.id, target.marker);
      const currentScreen = this.screen;
      const currentTarget = currentScreen?.actions.find(({ id }) => id === target.id);
      if (!currentScreen || !currentTarget || currentScreen.interaction?.interactionId !== before.interactionId || currentTarget.marker === target.marker) {
        return { type: 'error', content: '终端选择状态没有按预期更新，请用 /tail 检查。' };
      }
      return {
        type: 'refresh', content: `${currentTarget.marker === 'checked' || currentTarget.marker === 'selected' ? '已选择' : '已取消'}：${target.label}`,
        screen: currentScreen, paneId: session.paneId, agent: session.agent,
      };
    }
    if (target?.role === 'custom-input' || target?.role === 'chat') {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await this.poll();
      if (!before?.interactionId) return { type: 'error', content: '无法确认当前交互，请用 /tail 检查。' };
      this.pendingInteractionInput = {
        sessionId: session.id,
        interactionId: this.screen?.interaction?.interactionId ?? before.interactionId,
        controlId: target.id,
        role: target.role,
        label: target.label,
        cardMessageId: event.messageId,
        submitOnInput: target.role === 'chat' || before.semantics?.activation === 'submit',
        action,
      };
      return { type: 'awaiting-input', content: '请发送下一条普通消息。', agent: session.agent, label: target.label };
    }
    await this.waitForInteractionChange(before?.interactionId);
    if (this.screen?.interaction
      && this.screen.interaction.interactionId !== before?.interactionId
      && this.screen.interaction.semantics
      && (this.screen.interaction.actionConfidence ?? 0) >= 0.85) {
      return {
        type: 'refresh',
        content: '已进入下一步确认。',
        screen: this.screen,
        paneId: session.paneId,
        agent: session.agent,
      };
    }
    if ((target?.role === 'submit' || before?.semantics?.commit.mode === 'immediate')
      && this.screen?.interaction?.interactionId === before?.interactionId) {
      return { type: 'error', content: '终端仍停留在原问题，未确认提交成功。' };
    }
    await this.flushPending();
    return { type: 'success', content: result.value as string };
  }

  private async handleToggleFormSubmit(
    action: SignedAction,
    session: ManagedSession,
    formValue: Record<string, unknown>,
  ): Promise<LarkActionResult> {
    const initialScreen = this.screen;
    const interaction = initialScreen?.interaction;
    if (!initialScreen || !interaction?.interactionId || interaction.semantics?.activation !== 'toggle'
      || (interaction.revision ?? initialScreen.fingerprint) !== action.fingerprint
      || interaction.kind !== action.interactionKind) {
      return { type: 'error', content: '卡片状态已变化，请使用最新卡片。' };
    }
    const synced = await this.syncToggleFormState(session.paneId, initialScreen, formValue);
    if (!synced.ok) return { type: 'error', content: synced.error };

    if (synced.committed) {
      await this.waitForInteractionChange(interaction.interactionId);
      if (this.screen?.interaction?.interactionId === interaction.interactionId) {
        return { type: 'error', content: '自定义内容已同步，但终端仍停留在原问题。' };
      }
      if (this.screen?.interaction?.semantics && (this.screen.interaction.actionConfidence ?? 0) >= 0.85) {
        return {
          type: 'refresh', content: '答案已提交，已进入下一步确认。', screen: this.screen,
          paneId: session.paneId, agent: session.agent,
        };
      }
      await this.flushPending();
      return { type: 'success', content: `已向 ${getAgentAdapter(session.agent).displayName} 提交答案。` };
    }

    await this.poll();
    const current = this.screen;
    if (!current?.interaction || current.interaction.interactionId !== interaction.interactionId) {
      return { type: 'error', content: '终端问题在提交前已经变化，请使用最新卡片。' };
    }
    const commit = current.interaction.semantics?.commit;
    if (!commit || commit.mode === 'immediate') return { type: 'error', content: '无法确定终端提交方式，请用 /tail 检查。' };
    if (commit.mode === 'key') {
      await this.tmux.sendKey(session.paneId, commit.key);
    } else {
      const submit = current.actions.find(({ id }) => id === commit.controlId);
      if (!submit) return { type: 'error', content: '终端提交按钮已经变化，请使用最新卡片。' };
      const navigation = await this.navigateToControl(session.paneId, submit.id, interaction.interactionId);
      if (!navigation.ok) return { type: 'error', content: navigation.error };
      await this.tmux.sendKey(session.paneId, 'Enter');
    }

    await this.waitForInteractionChange(interaction.interactionId);
    if (this.screen?.interaction?.interactionId === interaction.interactionId) {
      return { type: 'error', content: '终端仍停留在原问题，未确认提交成功。' };
    }
    if (this.screen?.interaction?.semantics && (this.screen.interaction.actionConfidence ?? 0) >= 0.85) {
      return {
        type: 'refresh', content: '答案已提交，已进入下一步确认。', screen: this.screen,
        paneId: session.paneId, agent: session.agent,
      };
    }
    await this.flushPending();
    return { type: 'success', content: `已向 ${getAgentAdapter(session.agent).displayName} 提交答案。` };
  }

  private async withInteractionNotificationsSuppressed<T>(operation: () => Promise<T>): Promise<T> {
    this.interactionNotificationsSuppressed += 1;
    try {
      return await operation();
    } finally {
      this.interactionNotificationsSuppressed -= 1;
    }
  }

  private async key(key: string, fingerprint: string): Promise<DaemonResult> {
    return this.submitChoice(key, fingerprint);
  }

  private async submitChoice(
    choice: string,
    fingerprint: string,
    expectedKind?: 'approval' | 'question' | 'choice',
  ): Promise<DaemonResult> {
    const session = this.activeSession();
    if (!session) return { ok: false, error: 'no active managed session' };
    await this.poll();
    const screen = this.screen;
    const interaction = screen?.interaction;
    const revision = interaction?.revision ?? screen?.fingerprint;
    if (!screen || !interaction?.semantics || !interaction.actionConfidence || interaction.actionConfidence < 0.85
      || revision !== fingerprint || screen.actions.length === 0
      || (expectedKind && interaction.kind !== expectedKind)) {
      return { ok: false, error: 'choice screen changed; refusing stale action' };
    }
    const target = screen.actions.find((action) => action.key === choice);
    if (!target) return { ok: false, error: 'option is not valid for current choice' };
    if (target.shortcut && (target.role === 'custom-input' || target.role === 'chat')) {
      await this.tmux.sendKey(session.paneId, target.shortcut);
    } else {
      const navigation = await this.navigateToControl(session.paneId, target.id, interaction.interactionId);
      if (!navigation.ok) return navigation;
      await this.tmux.sendKey(session.paneId, 'Enter');
    }
    const verb = interaction.kind === 'approval' ? '提交审批选择' : interaction.kind === 'question' ? '提交答案' : '提交选择';
    return { ok: true, value: `已向 ${getAgentAdapter(session.agent).displayName} ${verb}：${target.label}` };
  }

  private async navigateToControl(paneId: string, targetId: string, interactionId?: string): Promise<DaemonResult> {
    for (let step = 0; step < 24; step += 1) {
      const screen = this.screen;
      if (!screen?.interaction || screen.interaction.interactionId !== interactionId) {
        return { ok: false, error: 'interaction changed while navigating; refusing action' };
      }
      const focusedIndex = screen.actions.findIndex(({ focused }) => focused);
      const targetIndex = screen.actions.findIndex(({ id }) => id === targetId);
      if (focusedIndex === -1 || targetIndex === -1) return { ok: false, error: 'cannot determine current or target focus' };
      if (focusedIndex === targetIndex) return { ok: true };
      const direction = targetIndex > focusedIndex ? 'Down' : 'Up';
      await this.tmux.sendKey(paneId, direction);
      await new Promise((resolve) => setTimeout(resolve, 40));
      await this.poll();
      const nextFocused = this.screen?.actions.findIndex(({ focused }) => focused) ?? -1;
      if (nextFocused === focusedIndex) return { ok: false, error: 'terminal focus did not move as expected' };
    }
    return { ok: false, error: 'terminal focus navigation exceeded its safe step limit' };
  }

  private async waitForInteractionChange(interactionId?: string): Promise<void> {
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 75));
      await this.poll();
      const current = this.screen?.interaction;
      if (!current || current.interactionId !== interactionId) return;
    }
  }

  private async waitForControlMarker(interactionId: string | undefined, controlId: string, marker: import('../screen/interaction-types.js').SelectionMarker | undefined): Promise<void> {
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 75));
      await this.poll();
      const current = this.screen?.interaction;
      const control = this.screen?.actions.find(({ id }) => id === controlId);
      if (!current || current.interactionId !== interactionId || control?.marker !== marker) return;
    }
  }

  private async waitForCustomInputValue(interactionId: string, controlId: string, input: string): Promise<void> {
    const expected = input.trim();
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 75));
      await this.poll();
      const control = this.screen?.actions.find(({ id }) => id === controlId);
      if (this.screen?.interaction?.interactionId === interactionId
        && control?.inputValue
        && (control.inputValue === expected || expected.startsWith(control.inputValue))) return;
    }
  }

  private async syncToggleFormState(
    paneId: string,
    initialScreen: ScreenDetection,
    formValue: Record<string, unknown>,
  ): Promise<{ ok: true; committed: boolean } | { ok: false; error: string }> {
    const interactionId = initialScreen.interaction?.interactionId;
    if (!interactionId) return { ok: false, error: '无法确定当前终端问题。' };
    const desiredControls = initialScreen.actions.flatMap((control, index) => {
      if (control.role !== 'answer' && control.role !== 'custom-input') return [];
      const selected = formChecked(formValue[choiceFormFieldName(index)]);
      const rawInput = formValue[inlineInputName(index)];
      const input = control.role === 'custom-input' && typeof rawInput === 'string'
        ? rawInput.trim()
        : undefined;
      return [{ id: control.id, role: control.role, selected, input, editor: control.editor }];
    }).sort((left, right) => Number(left.role === 'custom-input') - Number(right.role === 'custom-input'));
    const emptyCustom = desiredControls.find(({ role, selected, input }) => role === 'custom-input' && selected && !input);
    if (emptyCustom) return { ok: false, error: '已勾选自定义输入，但内容为空。请填写内容后再提交。' };

    const toggleKey = initialScreen.interaction?.semantics?.toggleKey ?? 'Enter';
    for (const desired of desiredControls) {
      await this.poll();
      let control = this.screen?.actions.find(({ id }) => id === desired.id);
      if (!control || this.screen?.interaction?.interactionId !== interactionId) {
        return { ok: false, error: '终端选项已经变化，请使用最新卡片。' };
      }
      const currentlySelected = control.marker === 'checked' || control.marker === 'selected';
      if (currentlySelected !== desired.selected) {
        const navigation = await this.navigateToControl(paneId, control.id, interactionId);
        if (!navigation.ok) return navigation;
        const previousMarker = control.marker;
        await this.tmux.sendKey(paneId, toggleKey);
        await this.waitForControlMarker(interactionId, control.id, previousMarker);
        control = this.screen?.actions.find(({ id }) => id === desired.id);
        const selectedAfterToggle = control?.marker === 'checked' || control?.marker === 'selected';
        if (!control || selectedAfterToggle !== desired.selected) {
          return { ok: false, error: `终端选项“${control?.label ?? desired.id}”没有按预期更新。` };
        }
      }
      if (desired.role !== 'custom-input' || !desired.selected || desired.input === undefined) continue;
      control = this.screen?.actions.find(({ id }) => id === desired.id);
      if (control?.inputValue?.trim() === desired.input) continue;
      const navigation = await this.navigateToControl(paneId, desired.id, interactionId);
      if (!navigation.ok) return navigation;
      if (desired.editor) {
        if (desired.editor.openKey) await this.tmux.sendKey(paneId, desired.editor.openKey);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await this.tmux.sendKey(paneId, 'C-u');
        await this.tmux.sendKey(paneId, 'C-k');
        await this.tmux.sendText(paneId, desired.input, false);
        await this.tmux.sendKey(paneId, desired.editor.submitKey);
        return { ok: true, committed: desired.editor.commitsInteraction };
      }
      await this.tmux.sendKey(paneId, 'C-u');
      await this.tmux.sendKey(paneId, 'C-k');
      await this.tmux.sendText(paneId, desired.input, false);
      await this.waitForCustomInputValue(interactionId, desired.id, desired.input);
      control = this.screen?.actions.find(({ id }) => id === desired.id);
      if (!control?.inputValue || !(desired.input === control.inputValue || desired.input.startsWith(control.inputValue))) {
        return { ok: false, error: '自定义内容没有完整同步到终端，请重试。' };
      }
    }
    return { ok: true, committed: false };
  }

  private async stopSession(sessionId = this.state.activeSessionId): Promise<DaemonResult> {
    if (!sessionId) {
      return fail(new AppError('SESSION_NOT_FOUND', 'no active managed session', { sessionId: 'default' }));
    }
    const session = this.state.sessions?.[sessionId];
    if (!session) {
      return fail(new AppError('SESSION_NOT_FOUND', `unknown session: ${sessionId}`, { sessionId }));
    }
    if (await this.tmux.hasSession(session.sessionName)) {
      await this.tmux.killSession(session.sessionName);
    }
    const sessions = { ...this.state.sessions };
    delete sessions[sessionId];
    const wasActive = this.state.activeSessionId === sessionId;
    const activeSessionId = wasActive
      ? Object.keys(sessions)[0]
      : this.state.activeSessionId;
    this.state = {
      ...this.state,
      sessions,
      activeSessionId,
      updatedAt: Date.now(),
    };
    if (wasActive) {
      this.screen = undefined;
      this.previousScreen = undefined;
      this.completedEvents.clear();
      this.clearPendingCompletion();
      this.pendingMessages.length = 0;
      this.pendingInteractionInput = undefined;
      this.unresolvedCandidate = undefined;
      this.unresolvedNotified.clear();
    }
    await this.store.saveState(this.state);
    return { ok: true };
  }

  private async resetOwner(): Promise<DaemonResult> {
    this.pendingMessages.length = 0;
    this.pendingInteractionInput = undefined;
    this.unresolvedCandidate = undefined;
    this.unresolvedNotified.clear();
    this.state = {
      ...this.state,
      ownerOpenId: undefined,
      boundChatId: undefined,
      autoBindDisabled: true,
      updatedAt: Date.now(),
    };
    await this.store.saveState(this.state);
    return { ok: true };
  }

  private async rotateBindCode(): Promise<DaemonResult> {
    if (Object.keys(this.state.sessions ?? {}).length === 0) return { ok: false, error: 'no managed coding-agent session is running' };
    const bindCode = createBindCode();
    this.state = {
      ...this.state,
      boundChatId: undefined,
      autoBindDisabled: true,
      bindCodeHash: hashBindCode(bindCode),
      bindCodeExpiresAt: Date.now() + 10 * 60_000,
      updatedAt: Date.now(),
    };
    await this.store.saveState(this.state);
    return { ok: true, value: { bindCode, expiresInSeconds: 600 } };
  }

  private schedulePoll(): void {
    if (this.closing) return;
    this.timer = setTimeout(() => {
      void this.runScheduledPoll();
    }, this.config.pollIntervalMs);
  }

  private async runScheduledPoll(): Promise<void> {
    const operation = this.poll().catch(async (error) => {
      if (!this.closing) await this.log(`poll failed: ${errorMessage(error)}`);
    });
    this.pollInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.pollInFlight === operation) this.pollInFlight = undefined;
      if (!this.closing) this.schedulePoll();
    }
  }

  private async poll(): Promise<void> {
    const session = this.activeSession();
    const paneId = session?.paneId;
    if (!paneId) {
      await this.reconcileSessions();
      return;
    }
    const pane = await this.tmux.inspect(paneId);
    const adapter = getAgentAdapter(session.agent);
    if (!pane || pane.dead) {
      this.updateScreen(adapter.detectScreen('', false));
      await this.notifyTransition();
      await this.maybeNotifyUnresolved();
      await this.maybeNotifyCompletion();
      await this.reconcileSessions();
      return;
    }
    const raw = await this.tmux.capture(paneId, 160);
    this.updateScreen(adapter.detectScreen(raw, true, { x: pane.cursorX, y: pane.cursorY }));
    await this.notifyTransition();
    await this.maybeNotifyUnresolved();
    await this.maybeNotifyCompletion();
    await this.flushPending();
    await this.reconcileSessions();
  }

  private async notifyTransition(): Promise<void> {
    const current = this.screen;
    const previous = this.previousScreen;
    this.previousScreen = current;
    const session = this.activeSession();
    if (!current || !session || !this.gateway) return;
    const agentName = getAgentAdapter(session.agent).displayName;
    if (previous?.state === current.state && previous.fingerprint === current.fingerprint
      && selectionSnapshot(previous) === selectionSnapshot(current)) return;
    if (this.interactionNotificationsSuppressed > 0 && current.interaction) return;
    try {
      if (!this.state.boundChatId) return;
      if (current.interaction?.semantics && current.interaction.actionConfidence && current.interaction.actionConfidence >= 0.85
        && current.actions.length > 0 && current.confidence >= 0.85) {
        await this.gateway.sendChoice(this.state.boundChatId, session.paneId, current, session.agent);
      } else if (current.state === 'failed' && previous?.state !== 'failed') {
        await this.gateway.sendText(this.state.boundChatId, `${agentName} 检测到失败状态，请用 /tail 查看。`);
      } else if (current.state === 'exited' && previous?.state !== 'exited') {
        await this.gateway.sendText(this.state.boundChatId, `${agentName}/tmux pane 已退出。`);
      }
    } catch (error) {
      await this.log(`notification failed: ${errorMessage(error)}`);
    }
  }

  private async maybeNotifyUnresolved(): Promise<void> {
    const screen = this.screen;
    const session = this.activeSession();
    if (this.interactionNotificationsSuppressed > 0 || !screen || !session || !this.gateway || !this.state.boundChatId
      || (screen.state !== 'input' && screen.state !== 'unknown') || safeStructuredInteraction(screen)) {
      this.unresolvedCandidate = undefined;
      return;
    }
    const key = `${session.id}:${session.paneId}:${screen.fingerprint}`;
    if (this.unresolvedCandidate?.key !== key) {
      this.unresolvedCandidate = { key, since: Date.now() };
      return;
    }
    if (Date.now() - this.unresolvedCandidate.since < 3_000 || this.unresolvedNotified.has(key)) return;
    remember(this.unresolvedNotified, key, 256);
    try {
      await this.gateway.sendManual(
        this.state.boundChatId,
        this.manualView(session, screen, 'active', '当前终端交互无法安全识别，已自动进入手动遥控兜底。'),
      );
    } catch (error) {
      await this.log(`manual fallback card failed: ${errorMessage(error)}`);
      await this.gateway.sendText(
        this.state.boundChatId,
        '当前终端交互无法安全识别，且手动遥控卡发送失败。可使用 /tail 120、/key、/type 或 /submit 处理。',
      ).catch((sendError) => this.log(`manual fallback text failed: ${errorMessage(sendError)}`));
    }
  }

  private async handleTurnComplete(candidate: TurnCompleteCandidate): Promise<DaemonResult> {
    if (!validTurnCompleteCandidate(candidate)) return { ok: false, error: 'invalid turn-complete candidate' };
    const eventKey = `${candidate.agentSessionId}:${candidate.eventId}`;
    if (this.completedEvents.has(eventKey)) return { ok: true };
    remember(this.completedEvents, eventKey, 256);
    if (candidate.sessionId !== this.state.activeSessionId) return { ok: true };
    if (!this.activeSession() || !this.state.boundChatId || !this.gateway) return { ok: true };
    this.pendingCompletion = candidate;
    this.pendingCompletionAt = Date.now();
    return { ok: true };
  }

  private updateScreen(next: ScreenDetection): void {
    if (this.screen?.fingerprint !== next.fingerprint || this.screen.state !== next.state) {
      this.outputStableSince = Date.now();
    }
    this.screen = next;
  }

  private async maybeNotifyCompletion(): Promise<void> {
    const candidate = this.pendingCompletion;
    const session = this.activeSession();
    if (!candidate || !session || !this.state.boundChatId || !this.gateway) return;
    if (this.screen?.state === 'approval' || this.screen?.state === 'input'
      || this.screen?.state === 'failed' || this.screen?.state === 'exited') {
      this.clearPendingCompletion();
      return;
    }
    if (this.screen?.state !== 'idle') return;
    const quietSince = Math.max(this.pendingCompletionAt, this.outputStableSince);
    if (Date.now() - quietSince < this.completionQuietMs) return;

    // Clear before sending so a slow Lark request cannot duplicate the notification.
    this.clearPendingCompletion();
    const adapter = getAgentAdapter(session.agent);
    const output = candidate.lastAssistantMessage.trim();
    if (!output) return;
    await this.gateway.sendMarkdown(
      this.state.boundChatId,
      `**${adapter.displayName} 等待用户输入**\n\n${output}`,
    );
  }

  private clearPendingCompletion(): void {
    this.pendingCompletion = undefined;
    this.pendingCompletionAt = 0;
  }

  private async flushPending(): Promise<void> {
    const session = this.activeSession();
    if (!session || this.shouldQueueMessage()) return;
    while (this.pendingMessages.length > 0 && !this.shouldQueueMessage()) {
      const message = this.pendingMessages[0];
      if (!message) {
        this.pendingMessages.shift();
        continue;
      }
      this.clearPendingCompletion();
      await this.tmux.sendText(session.paneId, message);
      this.pendingMessages.shift();
    }
    if (this.pendingMessages.length === 0 && this.state.boundChatId) {
      // Intentionally no per-message acknowledgement; transition notifications remain concise.
    }
  }

  private activeSession(): ManagedSession | undefined {
    return this.state.activeSessionId ? this.state.sessions?.[this.state.activeSessionId] : undefined;
  }

  private async reconcileSessions(): Promise<ManagedSession[]> {
    const sessions = Object.values(this.state.sessions ?? {});
    const inspections = await Promise.all(sessions.map(async (session) => ({
      session,
      pane: await this.tmux.inspect(session.paneId),
    })));
    const liveSessions = inspections
      .filter(({ pane }) => pane && !pane.dead)
      .map(({ session }) => session);
    const liveById = Object.fromEntries(liveSessions.map((session) => [session.id, session]));
    const activeSessionId = this.state.activeSessionId && liveById[this.state.activeSessionId]
      ? this.state.activeSessionId
      : liveSessions[0]?.id;
    const sessionsChanged = liveSessions.length !== sessions.length;
    const activeChanged = activeSessionId !== this.state.activeSessionId;
    if (!sessionsChanged && !activeChanged) return liveSessions;
    const removedActive = this.state.activeSessionId
      ? this.state.sessions?.[this.state.activeSessionId]
      : undefined;
    if (activeChanged && removedActive && !liveById[removedActive.id]
      && this.previousScreen?.state !== 'exited' && this.state.boundChatId) {
      await this.gateway?.sendText(
        this.state.boundChatId,
        `${getAgentAdapter(removedActive.agent).displayName}/tmux pane 已退出。`,
      ).catch((error) => this.log(`exit notification failed: ${errorMessage(error)}`));
    }
    this.state = {
      ...this.state,
      sessions: liveById,
      activeSessionId,
      updatedAt: Date.now(),
    };
    if (activeChanged) {
      this.screen = undefined;
      this.previousScreen = undefined;
      this.completedEvents.clear();
      this.clearPendingCompletion();
      this.pendingMessages.length = 0;
      this.pendingInteractionInput = undefined;
      this.unresolvedCandidate = undefined;
      this.unresolvedNotified.clear();
    }
    await this.store.saveState(this.state);
    return liveSessions;
  }

  private async useSession(sessionId: string): Promise<DaemonResult> {
    const session = this.state.sessions?.[sessionId];
    if (!session || !await this.tmux.inspect(session.paneId)) return { ok: false, error: `unknown or stopped session: ${sessionId}` };
    this.state = { ...this.state, activeSessionId: sessionId, updatedAt: Date.now() };
    this.screen = undefined;
    this.previousScreen = undefined;
    this.completedEvents.clear();
    this.clearPendingCompletion();
    this.pendingMessages.length = 0;
    this.pendingInteractionInput = undefined;
    this.unresolvedCandidate = undefined;
    this.unresolvedNotified.clear();
    await this.store.saveState(this.state);
    await this.poll();
    return { ok: true, value: session };
  }

  private async log(message: string): Promise<void> {
    await appendFile(this.paths.logFile, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  }
}

function fail(error: unknown): DaemonResult {
  return { ok: false, ...serializeAppError(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function validSessionId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,40}$/.test(value);
}

function remember(values: Set<string>, value: string, limit: number): void {
  values.add(value);
  while (values.size > limit) {
    const oldest = values.values().next().value as string | undefined;
    if (oldest === undefined) break;
    values.delete(oldest);
  }
}

function escapeFence(value: string): string {
  return value.replace(/```/g, '``\\`');
}

function selectionSnapshot(screen: ScreenDetection): string {
  return screen.actions.map(({ id, marker, inputValue }) => `${id}:${marker ?? ''}:${inputValue ?? ''}`).join('|');
}

function formChecked(value: unknown): boolean {
  return value === true || value === 1 || value === 'true' || value === '1' || value === 'on' || value === 'checked';
}

function safeStructuredInteraction(screen: ScreenDetection): boolean {
  return Boolean(
    screen.interaction?.semantics
    && screen.interaction.actionConfidence
    && screen.interaction.actionConfidence >= 0.85
    && screen.actions.length > 0
    && screen.confidence >= 0.85,
  );
}

function manualTmuxKey(value: string): string {
  const keys: Record<string, string> = {
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    enter: 'Enter',
    esc: 'Escape',
    tab: 'Tab',
    space: 'Space',
    backspace: 'BSpace',
    'ctrl-c': 'C-c',
  };
  const key = keys[value.toLowerCase()];
  if (!key) throw new Error(`不支持的手动按键：${value}`);
  return key;
}

function manualTimestamp(): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
}
