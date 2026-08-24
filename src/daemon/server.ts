import { appendFile, chmod, open, readFile, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { basename } from 'node:path';
import { runFile } from '../platform/process.js';
import type { ScreenDetection } from '../screen/detector.js';
import { tailScreen } from '../screen/normalize.js';
import { AppStore, createBindCode, hashBindCode } from '../core/store.js';
import type { AppConfig, ManagedSession, SessionState } from '../core/model.js';
import type { AppPaths } from '../core/paths.js';
import { AppError, isAppError, serializeAppError, systemErrorCode } from '../core/errors.js';
import { validateStartSessionRequest, type StartSessionRequest } from '../session/start-request.js';
import { sessionStartupFailure } from '../session/startup-failure.js';
import { SessionReconciler } from '../session/reconciler.js';
import { resolveNativeAgentSessionId } from '../session/native-session.js';
import { TmuxController } from '../tmux/controller.js';
import type { DaemonRequest, DaemonResult, RuntimeSessionStatus, RuntimeStatus } from './protocol.js';
import { getAgentAdapter } from '../agents/registry.js';
import type { AgentId, AgentResume, AgentSessionStartedCandidate, TurnCompleteCandidate } from '../agents/types.js';
import { validSessionStartCandidate, validTurnCompleteCandidate } from '../agents/stop-event.js';
import { LarkGateway, type GatewayFactory, type LarkActionResult, type RemoteGateway } from '../lark/gateway.js';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import type { SignedAction } from '../lark/action-signing.js';
import { verifyBindCode } from '../core/store.js';
import {
  CHOICE_FORM_SUBMIT_ACTION,
  MANUAL_TEXT_FIELD,
  SESSION_CREATE_AGENT_FIELD,
  SESSION_CREATE_CWD_FIELD,
  SESSION_CREATE_NAME_FIELD,
  SESSION_CREATE_RESUME_FIELD,
  choiceFormFieldName,
  inlineInputName,
  type ManualControlState,
  type ManualControlView,
} from '../lark/cards.js';
import { parseStartCommand } from '../lark/start-command.js';
import { normalizeAgentId } from '../agents/types.js';
import { parseResumePicker, type ResumePickerView } from '../screen/resume-picker.js';
import { startupTerminalExcerpt } from '../terminal/startup-error.js';

export class AssistantDaemon {
  private config!: AppConfig;
  private state!: SessionState;
  private tmux!: TmuxController;
  private reconciler!: SessionReconciler;
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
  private readonly pendingAgentSessionClaims = new Map<string, AgentSessionStartedCandidate>();
  private readonly pendingResumePickers = new Map<string, StartSessionRequest>();
  private readonly pendingStartupConflicts = new Map<string, { request: StartSessionRequest; ownerSessionId: string }>();
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
    this.reconciler = new SessionReconciler(
      this.tmux,
      this.sessionName,
      3,
      (message) => this.log(message),
      async (agent) => {
        const adapter = getAgentAdapter(agent);
        return (await runFile(adapter.binary(this.config), [...adapter.versionArgs])).stdout.trim();
      },
    );
    const secrets = await this.store.loadSecrets();
    if (!secrets) throw new Error('missing secrets; run lark-coding-assistant init again');
    await this.acquireRuntimeFiles();
    try {
      await this.reconcileSessions(true);
      await rm(this.paths.socket, { force: true });
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.paths.socket, () => resolve());
      });
      await chmod(this.paths.socket, 0o600);
      this.gateway = this.gatewayFactory(config, secrets, {
        onMessage: (message) => this.onLarkMessage(message),
        onAction: (event, action) => this.onLarkAction(event, action),
        onResumePickerDeliveryFailure: (session) => this.handleResumePickerDeliveryFailure(session),
      });
      await this.gateway.connect();
      await this.refreshNativeAgentSessionClaims();
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
      case 'agentSessionStarted': return this.handleAgentSessionStarted(request.candidate);
      case 'turnComplete': return this.handleTurnComplete(request.candidate);
    }
  }

  private async startSession(
    sessionId: string,
    cwd: string,
    agentId: AgentId,
    resume?: AgentResume,
  ): Promise<DaemonResult> {
    try {
      await validateStartSessionRequest({ sessionId, cwd, agent: agentId, resume });
    } catch (error) {
      return fail(error);
    }
    await this.reconcileSessions(true);
    const existing = this.state.sessions?.[sessionId];
    if (existing) {
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
    let agentVersion: string;
    try {
      agentVersion = (await runFile(binary, [...adapter.versionArgs])).stdout.trim();
    } catch (error) {
      return fail(systemErrorCode(error) === 'ENOENT'
        ? new AppError('BINARY_NOT_FOUND', `command not found: ${binary}`, { binary }, { cause: error })
        : new AppError('START_FAILED', `failed to inspect agent binary: ${binary}`, { sessionId }, { cause: error }));
    }
    const tmuxSessionName = `${this.sessionName}-${sessionId}`;
    let pane;
    try {
      pane = await this.tmux.create({
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
          LARK_CODING_ASSISTANT_AGENT: agentId,
        },
        preserveOnExit: true,
      });
    } catch (error) {
      return fail(isAppError(error)
        ? error
        : new AppError('START_FAILED', 'failed to create tmux session', { sessionId }, { cause: error }));
    }
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
    const pendingClaim = this.pendingAgentSessionClaims.get(sessionId);
    if (pendingClaim?.agent === agentId) {
      const owner = this.findAgentSessionOwner(agentId, pendingClaim.agentSessionId, sessionId);
      if (owner) {
        this.pendingAgentSessionClaims.delete(sessionId);
        await this.tmux.killSession(pane.sessionName).catch(() => undefined);
        return fail(agentSessionInUse(sessionId, owner.id));
      }
      session.agentSessionId = pendingClaim.agentSessionId;
      this.pendingAgentSessionClaims.delete(sessionId);
    }
    try {
      await this.tmux.writeMetadata(pane.sessionName, {
        managed: true,
        sessionId,
        agent: agentId,
        cwd,
        agentVersion,
        agentSessionId: session.agentSessionId,
      });
    } catch (error) {
      await this.tmux.killSession(pane.sessionName).catch((cleanupError) => this.log(
        `failed to clean session ${sessionId} after metadata error: ${errorMessage(cleanupError)}`,
      ));
      return fail(new AppError('START_FAILED', 'failed to persist tmux session metadata', { sessionId }, { cause: error }));
    }
    const nextState: SessionState = {
      ...this.state,
      sessions: { ...this.state.sessions, [sessionId]: session },
      activeSessionId: this.state.activeSessionId ?? sessionId,
      boundChatId: binding.mode === 'reused' ? this.state.boundChatId : undefined,
      bindCodeHash: binding.mode === 'code' ? hashBindCode(binding.bindCode) : undefined,
      bindCodeExpiresAt: binding.mode === 'code' ? Date.now() + 10 * 60_000 : undefined,
      updatedAt: Date.now(),
    };
    try {
      await this.store.saveState(nextState);
    } catch (error) {
      await this.tmux.killSession(pane.sessionName).catch((cleanupError) => this.log(
        `failed to clean session ${sessionId} after state error: ${errorMessage(cleanupError)}`,
      ));
      return fail(new AppError('START_FAILED', 'failed to persist session state', { sessionId }, { cause: error }));
    }
    this.state = nextState;
    const lateClaim = this.pendingAgentSessionClaims.get(sessionId);
    if (lateClaim) {
      const claimed = await this.handleAgentSessionStarted(lateClaim);
      if (!claimed.ok) {
        await this.stopSession(sessionId).catch(() => undefined);
        return claimed;
      }
    }
    if (resume && resume.mode !== 'picker') {
      const initialClaim = await this.waitForInitialAgentSessionClaim(sessionId, pane.pid);
      if (!initialClaim.ok) {
        await this.stopSession(sessionId).catch(() => undefined);
        return initialClaim;
      }
    } else if (!resume) {
      const stable = await this.waitForStartupStability(session, 500);
      if (!stable.ok) {
        await this.stopSession(sessionId).catch(() => undefined);
        return stable;
      }
    }
    if (resume?.mode !== 'picker') {
      await this.tmux.preserveOnExit(session.sessionName, false).catch((error) => this.log(
        `failed to disable startup preservation for ${sessionId}: ${errorMessage(error)}`,
      ));
    }
    await this.log(
      `session created: session=${session.id} agent=${session.agent} pane=${session.paneId} active=${this.state.activeSessionId === session.id}`,
    );
    await this.poll().catch((error) => this.log(`initial poll failed for ${sessionId}: ${errorMessage(error)}`));
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

  private async runtimeStatus(sessionId?: string): Promise<RuntimeStatus> {
    const selectedSessionId = sessionId ?? this.state.activeSessionId;
    const selected = selectedSessionId ? this.state.sessions?.[selectedSessionId] : undefined;
    const requestedSessions = sessionId
      ? (selected ? [selected] : [])
      : Object.values(this.state.sessions ?? {});
    const sessions = await Promise.all(requestedSessions.map((session) => this.sessionRuntimeStatus(session)));
    const selectedRuntime = selected
      ? sessions.find(({ session }) => session.id === selected.id)
        ?? await this.sessionRuntimeStatus(selected)
      : undefined;
    return {
      state: this.state,
      session: selected,
      screen: selectedRuntime?.screen,
      paneAlive: selectedRuntime?.paneAlive === true,
      sessions,
    };
  }

  private async sessionRuntimeStatus(session: ManagedSession): Promise<RuntimeSessionStatus> {
    const active = session.id === this.state.activeSessionId;
    try {
      const pane = await this.tmux.inspect(session.paneId);
      if (!pane || pane.dead) {
        return {
          session,
          screen: getAgentAdapter(session.agent).detectScreen('', false),
          paneAlive: false,
          active,
        };
      }
      const screen = active && this.screen
        ? this.screen
        : getAgentAdapter(session.agent).detectScreen(
          await this.tmux.capture(session.paneId, 160),
          true,
          { x: pane.cursorX, y: pane.cursorY },
        );
      return { session, screen, paneAlive: true, active };
    } catch {
      return { session, active };
    }
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

    if (text === '/start') {
      try {
        await this.gateway?.sendSessionCreate(message.chatId);
      } catch (error) {
        await this.log(`session create card failed: ${errorMessage(error)}`);
        await this.gateway?.sendText(message.chatId, '新建 Session 表单发送失败。请使用 /start <name> --agent <agent> --cwd <绝对路径>。');
      }
      return;
    }
    if (text.startsWith('/start ')) {
      let request: StartSessionRequest;
      try {
        request = parseStartCommand(text);
      } catch (error) {
        await this.gateway?.sendText(message.chatId, remoteError(fail(error)));
        return;
      }
      const result = await this.startRemoteSession(request);
      if (!result.ok) {
        const failure = sessionStartupFailure(result.error, request);
        if (failure) await this.gateway?.sendSessionStartupFailure(message.chatId, failure);
        else await this.gateway?.sendText(message.chatId, remoteError(result.error));
      }
      else if (result.state === 'picker') {
        try {
          await this.gateway?.sendResumePicker(message.chatId, result.session, result.picker);
        } catch (error) {
          await this.handleResumePickerDeliveryFailure(result.session);
          await this.log(`resume picker notification failed: session=${result.session.id} error=${errorMessage(error)}`);
          await this.gateway?.sendText(message.chatId, 'Resume Picker 卡片发送失败，临时 Session 已清理，请重试。');
        }
      }
      else if (result.state === 'conflict') await this.gateway?.sendStartupConflict(message.chatId, result.request, result.owner);
      else await this.gateway?.sendText(message.chatId, remoteStartSuccess(result.session));
      return;
    }

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
      const sessions = await this.reconcileSessions(true);
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
    if (action.kind === 'session-stop') return this.handleSessionStopAction(action);
    if (action.kind === 'session-start-error') {
      if (action.action === 'create') return { type: 'session-create-form', content: '请填写启动信息。' };
      if (action.action === 'sessions') {
        await this.reconcileSessions(true);
        return this.sessionPickerActionResult('已发送最新 Sessions。');
      }
      return { type: 'error', content: '无法识别启动失败卡片操作。' };
    }
    if (action.kind === 'startup-conflict') return this.handleStartupConflictAction(action);
    if (action.kind === 'resume-picker') return this.handleResumePickerAction(action);
    if (action.kind === 'session-create') {
      if (action.action === 'open') {
        return {
          type: 'session-create-form',
          content: '请填写启动信息。',
          sessions: Object.values(this.state.sessions ?? {}),
          activeSessionId: this.state.activeSessionId,
        };
      }
      if (action.action !== 'submit' || !event.action.formValue) {
        return { type: 'error', content: '无法识别新建 Session 表单，请重新发送 /sessions。' };
      }
      const request = startRequestFromForm(event.action.formValue);
      if (!request.ok) return { type: 'error', content: request.error };
      const result = await this.startRemoteSession(request.value);
      if (!result.ok) return larkStartupError(result.error, request.value);
      if (result.state === 'picker') {
        return { type: 'resume-picker', content: '请选择要恢复的历史 Session。', session: result.session, picker: result.picker };
      }
      if (result.state === 'conflict') {
        return { type: 'startup-conflict', content: '目标原生 Session 已由现有 LCA Session 连接。', request: result.request, owner: result.owner };
      }
      return { type: 'session-created', content: remoteStartSuccess(result.session), session: result.session };
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

  private async handleSessionStopAction(action: SignedAction): Promise<LarkActionResult> {
    const sessionId = action.sessionId ?? '';
    const target = this.state.sessions?.[sessionId];
    if (!target
      || target.agent !== action.agent
      || target.paneId !== action.paneId
      || String(target.updatedAt) !== action.fingerprint) {
      return { type: 'error', content: '目标 session 已变化，请重新发送 /sessions。' };
    }
    if (action.action === 'request') {
      return this.sessionPickerActionResult(`请确认是否关闭 ${target.id}。`, target.id);
    }
    if (action.action === 'cancel') {
      return this.sessionPickerActionResult(`已取消关闭 ${target.id}。`);
    }
    if (action.action !== 'confirm') return { type: 'error', content: '无法识别关闭操作，请重新发送 /sessions。' };
    const stopped = await this.stopSession(target.id);
    if (!stopped.ok) return { type: 'error', content: remoteError(stopped) };
    return this.sessionPickerActionResult(`已关闭 ${target.id}。`);
  }

  private async handleStartupConflictAction(action: SignedAction): Promise<LarkActionResult> {
    const requestedSessionId = action.sessionId ?? '';
    const pending = this.pendingStartupConflicts.get(requestedSessionId);
    const owner = pending ? this.state.sessions?.[pending.ownerSessionId] : undefined;
    if (!pending || !owner || pending.request.agent !== action.agent
      || owner.paneId !== action.paneId || String(owner.updatedAt) !== action.fingerprint) {
      return { type: 'error', content: 'Session 冲突状态已变化，请重新创建 Session。' };
    }
    if (action.action === 'cancel') {
      this.pendingStartupConflicts.delete(requestedSessionId);
      return { type: 'success', content: `已取消创建 ${requestedSessionId}。` };
    }
    if (action.action === 'connect') {
      const selected = await this.useSession(owner.id);
      if (!selected.ok) return { type: 'error', content: remoteError(selected) };
      this.pendingStartupConflicts.delete(requestedSessionId);
      return { type: 'session-created', content: `已连接现有 session「${owner.id}」。`, session: owner };
    }
    if (action.action !== 'new') return { type: 'error', content: '无法识别冲突处理操作。' };
    this.pendingStartupConflicts.delete(requestedSessionId);
    const result = await this.startRemoteSession({ ...pending.request, resume: undefined });
    if (!result.ok) return larkStartupError(result.error, pending.request);
    if (result.state !== 'ready') return { type: 'error', content: '启动新会话时出现了意外恢复状态，请重试。' };
    return { type: 'session-created', content: remoteStartSuccess(result.session), session: result.session };
  }

  private sessionPickerActionResult(content: string, confirmingStopSessionId?: string): LarkActionResult {
    return {
      type: 'session-picker',
      content,
      sessions: Object.values(this.state.sessions ?? {}),
      activeSessionId: this.state.activeSessionId,
      confirmingStopSessionId,
    };
  }

  private async handleResumePickerAction(action: SignedAction): Promise<LarkActionResult> {
    const sessionId = action.sessionId ?? '';
    const request = this.pendingResumePickers.get(sessionId);
    const session = this.state.sessions?.[sessionId];
    if (!request || !session || session.agent !== action.agent || session.paneId !== action.paneId) {
      return { type: 'error', content: 'Resume Picker 已变化，请重新创建 Session。' };
    }
    if (action.action === 'cancel') {
      this.pendingResumePickers.delete(sessionId);
      const stopped = await this.stopSession(sessionId);
      return stopped.ok
        ? { type: 'success', content: `已取消创建 ${sessionId}。` }
        : { type: 'error', content: remoteError(stopped) };
    }
    let picker = await this.readResumePicker(session);
    if (!picker) {
      this.pendingResumePickers.delete(sessionId);
      return { type: 'error', content: '原生 Resume Picker 当前无法安全识别，已允许手动遥控兜底；请发送 /manual。' };
    }
    if (action.action !== 'refresh' && picker.fingerprint !== action.fingerprint) {
      return { type: 'resume-picker', content: 'Picker 已变化，已刷新为最新内容。', session, picker };
    }
    if (action.action === 'refresh') {
      return { type: 'resume-picker', content: '已刷新 Resume Picker。', session, picker };
    }
    if (action.action === 'previous' || action.action === 'next') {
      await this.tmux.sendKey(session.paneId, action.action === 'previous' ? 'PPage' : 'NPage');
      picker = await this.waitForResumePicker(session, picker.fingerprint) ?? picker;
      return { type: 'resume-picker', content: '已切换 Picker 页面。', session, picker };
    }
    const optionId = action.action.startsWith('select:') ? action.action.slice('select:'.length) : '';
    const option = picker.options.find((candidate) => candidate.id === optionId);
    if (!option) return { type: 'resume-picker', content: '所选项已变化，已刷新。', session, picker };
    const delta = option.visibleIndex - picker.selectedIndex;
    const key = delta < 0 ? 'Up' : 'Down';
    for (let step = 0; step < Math.abs(delta); step += 1) await this.tmux.sendKey(session.paneId, key);
    const pane = await this.tmux.inspect(session.paneId);
    if (!pane || pane.dead) {
      this.pendingResumePickers.delete(sessionId);
      return larkStartupError(fail(await this.startupExitedError(session, pane)), request);
    }
    await this.tmux.sendKey(session.paneId, 'Enter');
    this.pendingResumePickers.delete(sessionId);
    const claimed = await this.waitForInitialAgentSessionClaim(sessionId, pane.pid);
    if (!claimed.ok) {
      await this.stopSession(sessionId).catch(() => undefined);
      if (claimed.errorCode === 'AGENT_SESSION_IN_USE') {
        const ownerSessionId = typeof claimed.errorContext?.ownerSessionId === 'string'
          ? claimed.errorContext.ownerSessionId
          : undefined;
        const owner = ownerSessionId ? this.state.sessions?.[ownerSessionId] : undefined;
        if (owner) {
          this.pendingStartupConflicts.set(sessionId, { request, ownerSessionId: owner.id });
          return {
            type: 'startup-conflict',
            content: '所选原生 Session 已由现有 LCA Session 连接。',
            request,
            owner,
          };
        }
      }
      return larkStartupError(claimed, request);
    }
    await this.tmux.preserveOnExit(session.sessionName, false).catch(() => undefined);
    const selected = await this.useSession(sessionId);
    if (!selected.ok) return { type: 'error', content: remoteError(selected) };
    return { type: 'session-created', content: remoteStartSuccess(session), session };
  }

  private async readResumePicker(session: ManagedSession): Promise<ResumePickerView | undefined> {
    const pane = await this.tmux.inspect(session.paneId);
    if (!pane || pane.dead) return undefined;
    const raw = await this.tmux.capture(session.paneId, 120).catch(() => '');
    return parseResumePicker(raw, session.agent);
  }

  private async handleResumePickerDeliveryFailure(candidate: ManagedSession): Promise<void> {
    const current = this.state.sessions?.[candidate.id];
    if (!current || current.paneId !== candidate.paneId || !this.pendingResumePickers.has(candidate.id)) return;
    await this.log(`resume picker delivery failed; rolling back provisional session: session=${candidate.id} pane=${candidate.paneId}`);
    await this.stopSession(candidate.id);
  }

  private async waitForResumePicker(
    session: ManagedSession,
    previousFingerprint?: string,
    timeoutMs = 2_500,
  ): Promise<ResumePickerView | undefined> {
    const deadline = Date.now() + timeoutMs;
    let latest: ResumePickerView | undefined;
    while (Date.now() < deadline) {
      latest = await this.readResumePicker(session);
      if (latest && (!previousFingerprint || latest.fingerprint !== previousFingerprint)) return latest;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return latest;
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
    this.pendingResumePickers.delete(sessionId);
    this.pendingStartupConflicts.delete(sessionId);
    for (const [pendingId, conflict] of this.pendingStartupConflicts) {
      if (conflict.ownerSessionId === sessionId) this.pendingStartupConflicts.delete(pendingId);
    }
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
    await this.refreshNativeAgentSessionClaims();
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
      || this.pendingResumePickers?.has(session.id)
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
      await this.log(
        `manual fallback sent: session=${session.id} agent=${session.agent} pane=${session.paneId} state=${screen.state} fingerprint=${screen.fingerprint}`,
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
    const completingSession = this.state.sessions?.[candidate.sessionId];
    if (completingSession) {
      const claimed = await this.handleAgentSessionStarted({
        sessionId: candidate.sessionId,
        agent: completingSession.agent,
        agentSessionId: candidate.agentSessionId,
        cwd: candidate.cwd,
        source: 'Stop',
      });
      if (!claimed.ok) return claimed;
    }
    const eventKey = `${candidate.agentSessionId}:${candidate.eventId}`;
    if (this.completedEvents.has(eventKey)) return { ok: true };
    remember(this.completedEvents, eventKey, 256);
    if (candidate.sessionId !== this.state.activeSessionId) return { ok: true };
    if (!this.activeSession() || !this.state.boundChatId || !this.gateway) return { ok: true };
    this.pendingCompletion = candidate;
    this.pendingCompletionAt = Date.now();
    return { ok: true };
  }

  private async handleAgentSessionStarted(candidate: AgentSessionStartedCandidate): Promise<DaemonResult> {
    if (!validSessionStartCandidate(candidate)) return { ok: false, error: 'invalid agent-session candidate' };
    const session = this.state.sessions?.[candidate.sessionId];
    if (session && session.agent !== candidate.agent) {
      return { ok: false, error: 'agent-session candidate does not match managed session' };
    }
    const owner = this.findAgentSessionOwner(candidate.agent, candidate.agentSessionId, candidate.sessionId);
    if (owner) {
      this.pendingAgentSessionClaims.set(candidate.sessionId, candidate);
      await this.log(
        `agent session conflict: session=${candidate.sessionId} agent=${candidate.agent} agentSession=${candidate.agentSessionId} owner=${owner.id}`,
      );
      setTimeout(() => void this.rejectDuplicateAgentSession(candidate, owner), 100);
      return fail(agentSessionInUse(candidate.sessionId, owner.id));
    }
    if (!session) {
      this.pendingAgentSessionClaims.set(candidate.sessionId, candidate);
      return { ok: true };
    }
    if (session.agentSessionId === candidate.agentSessionId) return { ok: true };
    const updated = { ...session, agentSessionId: candidate.agentSessionId, updatedAt: Date.now() };
    this.state = {
      ...this.state,
      sessions: { ...this.state.sessions, [session.id]: updated },
      updatedAt: Date.now(),
    };
    this.pendingAgentSessionClaims.delete(session.id);
    await this.store.saveState(this.state);
    await this.tmux.writeMetadata(session.sessionName, {
      managed: true,
      sessionId: session.id,
      agent: session.agent,
      cwd: session.cwd,
      agentVersion: session.agentVersion,
      agentSessionId: candidate.agentSessionId,
    }).catch((error) => this.log(`failed to persist agent session claim for ${session.id}: ${errorMessage(error)}`));
    await this.log(
      `agent session claimed: session=${session.id} agent=${session.agent} agentSession=${candidate.agentSessionId}`,
    );
    return { ok: true };
  }

  private async refreshNativeAgentSessionClaims(): Promise<void> {
    for (const session of Object.values(this.state.sessions ?? {})) {
      if (session.agentSessionId) continue;
      const pane = await this.tmux.inspect(session.paneId);
      if (!pane || pane.dead) continue;
      const agentSessionId = await resolveNativeAgentSessionId(session.agent, pane.pid).catch((error) => {
        void this.log(`failed to resolve native agent session for ${session.id}: ${errorMessage(error)}`);
        return undefined;
      });
      if (!agentSessionId) continue;
      await this.handleAgentSessionStarted({
        sessionId: session.id,
        agent: session.agent,
        agentSessionId,
        cwd: session.cwd,
        source: 'runtime-discovery',
      });
    }
  }

  private async waitForInitialAgentSessionClaim(sessionId: string, panePid: number): Promise<DaemonResult> {
    const deadline = Date.now() + 3_500;
    while (Date.now() < deadline) {
      const session = this.state.sessions?.[sessionId];
      if (!session) return { ok: false, error: `session disappeared during startup: ${sessionId}` };
      if (session.agentSessionId) return { ok: true };
      const pane = await this.tmux.inspect(session.paneId);
      if (!pane || pane.dead) return fail(await this.startupExitedError(session, pane));
      const agentSessionId = await resolveNativeAgentSessionId(session.agent, panePid).catch(() => undefined);
      if (agentSessionId) {
        return this.handleAgentSessionStarted({
          sessionId,
          agent: session.agent,
          agentSessionId,
          cwd: session.cwd,
          source: 'startup-discovery',
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const session = this.state.sessions?.[sessionId];
    if (!session) return fail(new AppError('SESSION_NOT_FOUND', `session disappeared during startup: ${sessionId}`, { sessionId }));
    const pane = await this.tmux.inspect(session.paneId);
    if (!pane || pane.dead) return fail(await this.startupExitedError(session, pane));
    if (session.agentSessionId || this.pendingAgentSessionClaims.has(sessionId)) return { ok: true };
    return fail(new AppError(
      'AGENT_IDENTITY_TIMEOUT',
      `unable to identify resumed native session: ${sessionId}`,
      { sessionId, agent: session.agent },
    ));
  }

  private async startupExitedError(session: ManagedSession, pane?: { exitStatus?: number }): Promise<AppError> {
    const terminalTail = await this.tmux.capture(session.paneId, 40)
      .then((output) => tailScreen(output, 40).slice(-3_000))
      .catch(() => '');
    return new AppError(
      'AGENT_EXITED_DURING_STARTUP',
      `agent exited during startup: ${session.id}`,
      {
        sessionId: session.id,
        agent: session.agent,
        terminalExcerpt: startupTerminalExcerpt(terminalTail),
        exitStatus: pane?.exitStatus,
      },
    );
  }

  private async waitForStartupStability(session: ManagedSession, durationMs: number): Promise<DaemonResult> {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      const pane = await this.tmux.inspect(session.paneId);
      if (!pane || pane.dead) return fail(await this.startupExitedError(session, pane));
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return { ok: true };
  }

  private findAgentSessionOwner(
    agent: AgentId,
    agentSessionId: string,
    excludeSessionId: string,
  ): Pick<ManagedSession, 'id'> | undefined {
    const persisted = Object.values(this.state.sessions ?? {}).find((candidate) => (
      candidate.id !== excludeSessionId
      && candidate.agent === agent
      && candidate.agentSessionId === agentSessionId
    ));
    if (persisted) return persisted;
    const pending = [...this.pendingAgentSessionClaims.values()].find((candidate) => (
      candidate.sessionId !== excludeSessionId
      && candidate.agent === agent
      && candidate.agentSessionId === agentSessionId
    ));
    return pending ? { id: pending.sessionId } : undefined;
  }

  private async rejectDuplicateAgentSession(
    candidate: AgentSessionStartedCandidate,
    owner: Pick<ManagedSession, 'id'>,
  ): Promise<void> {
    const duplicate = this.state.sessions?.[candidate.sessionId];
    if (duplicate) await this.stopSession(duplicate.id).catch((error) => this.log(
      `failed to stop duplicate agent session ${duplicate.id}: ${errorMessage(error)}`,
    ));
    else {
      const sessionName = `${this.sessionName}-${candidate.sessionId}`;
      if (await this.tmux.hasSession(sessionName)) await this.tmux.killSession(sessionName).catch(() => undefined);
    }
    this.pendingAgentSessionClaims.delete(candidate.sessionId);
    if (this.state.boundChatId) {
      await this.gateway?.sendText(
        this.state.boundChatId,
        `${candidate.agent} 原生 session 已由 LCA session「${owner.id}」连接；已停止重复创建的「${candidate.sessionId}」。请用 /sessions 连接「${owner.id}」。`,
      ).catch((error) => this.log(`agent session conflict notification failed: ${errorMessage(error)}`));
    }
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

  private async reconcileSessions(discover = false): Promise<ManagedSession[]> {
    const previousActive = this.state.activeSessionId;
    const result = await this.reconciler.reconcile(this.state, discover);
    if (!result.changed) return result.liveSessions;
    const activeChanged = result.state.activeSessionId !== previousActive;
    if (result.removedActive) {
      await this.log(
        `session removed: session=${result.removedActive.id} agent=${result.removedActive.agent} pane=${result.removedActive.paneId} wasActive=true nextActive=${result.state.activeSessionId ?? '-'}`,
      );
    }
    if (activeChanged && result.removedActive
      && this.previousScreen?.state !== 'exited' && this.state.boundChatId) {
      await this.gateway?.sendText(
        this.state.boundChatId,
        `${getAgentAdapter(result.removedActive.agent).displayName}/tmux pane 已退出。`,
      ).catch((error) => this.log(`exit notification failed: ${errorMessage(error)}`));
    }
    this.state = result.state;
    for (const sessionId of this.pendingResumePickers.keys()) {
      if (!this.state.sessions?.[sessionId]) this.pendingResumePickers.delete(sessionId);
    }
    for (const [sessionId, conflict] of this.pendingStartupConflicts) {
      if (!this.state.sessions?.[conflict.ownerSessionId]) this.pendingStartupConflicts.delete(sessionId);
    }
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
    return result.liveSessions;
  }

  private async useSession(sessionId: string): Promise<DaemonResult> {
    const session = this.state.sessions?.[sessionId];
    if (!session) return fail(new AppError('SESSION_NOT_FOUND', `unknown session: ${sessionId}`, { sessionId }));
    const pane = await this.tmux.inspect(session.paneId);
    if (!pane || pane.dead) return fail(await this.startupExitedError(session, pane));
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
    await this.log(`session activated: session=${session.id} agent=${session.agent} pane=${session.paneId}`);
    return { ok: true, value: session };
  }

  private async startRemoteSession(
    request: StartSessionRequest,
  ): Promise<
    | { ok: true; state: 'ready'; session: ManagedSession }
    | { ok: true; state: 'picker'; session: ManagedSession; picker: ResumePickerView }
    | { ok: true; state: 'conflict'; request: StartSessionRequest; owner: ManagedSession }
    | { ok: false; error: DaemonResult }
  > {
    await this.log(
      `remote session create requested: session=${request.sessionId} agent=${request.agent} resume=${request.resume?.mode ?? 'new'}`,
    );
    const started = await this.startSession(request.sessionId, request.cwd, request.agent, request.resume);
    if (!started.ok) {
      await this.log(`remote session create failed: session=${request.sessionId} code=${started.errorCode ?? 'UNKNOWN'}`);
      if (started.errorCode === 'AGENT_SESSION_IN_USE') {
        const ownerSessionId = typeof started.errorContext?.ownerSessionId === 'string'
          ? started.errorContext.ownerSessionId
          : undefined;
        const owner = ownerSessionId ? this.state.sessions?.[ownerSessionId] : undefined;
        if (owner) {
          this.pendingStartupConflicts.set(request.sessionId, { request, ownerSessionId: owner.id });
          return { ok: true, state: 'conflict', request, owner };
        }
      }
      return { ok: false, error: started };
    }
    const selected = await this.useSession(request.sessionId);
    if (!selected.ok) {
      await this.log(`remote session activation failed: session=${request.sessionId} code=${selected.errorCode ?? 'UNKNOWN'}`);
      return { ok: false, error: selected };
    }
    const session = selected.value as ManagedSession;
    if (request.resume?.mode === 'picker') {
      const picker = await this.waitForResumePicker(session);
      if (picker) {
        this.pendingResumePickers.set(session.id, request);
        return { ok: true, state: 'picker', session, picker };
      }
      await this.tmux.preserveOnExit(session.sessionName, false).catch((error) => this.log(
        `failed to disable remain-on-exit after resume picker fallback: session=${session.id} error=${errorMessage(error)}`,
      ));
    }
    return { ok: true, state: 'ready', session };
  }

  private async log(message: string): Promise<void> {
    await appendFile(this.paths.logFile, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  }
}

function fail(error: unknown): DaemonResult {
  return { ok: false, ...serializeAppError(error) };
}

function agentSessionInUse(sessionId: string, ownerSessionId: string): AppError {
  return new AppError(
    'AGENT_SESSION_IN_USE',
    `agent session is already managed by ${ownerSessionId}`,
    { sessionId, ownerSessionId },
  );
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

function remember(values: Set<string>, value: string, limit: number): void {
  values.add(value);
  while (values.size > limit) {
    const oldest = values.values().next().value as string | undefined;
    if (oldest === undefined) break;
    values.delete(oldest);
  }
}

function startRequestFromForm(
  values: Record<string, unknown>,
): { ok: true; value: StartSessionRequest } | { ok: false; error: string } {
  const sessionId = formString(values[SESSION_CREATE_NAME_FIELD]);
  const agentValue = formString(values[SESSION_CREATE_AGENT_FIELD]);
  const cwd = formString(values[SESSION_CREATE_CWD_FIELD]);
  const resumeMode = formString(values[SESSION_CREATE_RESUME_FIELD]) || 'new';
  if (!sessionId) return { ok: false, error: '请填写 Session 名称。' };
  const agent = normalizeAgentId(agentValue);
  if (!agent) return { ok: false, error: '请选择有效的 Agent：codex、traex 或 claude。' };
  if (!cwd) return { ok: false, error: '请填写绝对工作目录。' };
  let resume: AgentResume | undefined;
  if (resumeMode === 'last') {
    return { ok: false, error: '飞书已不再支持“恢复上次会话”，请重新打开表单并使用 Resume Picker。' };
  }
  if (resumeMode === 'picker') resume = { mode: 'picker' };
  else if (resumeMode !== 'new') {
    return { ok: false, error: '无法识别启动方式，请重新打开新建 Session 表单。' };
  }
  return { ok: true, value: { sessionId, agent, cwd, resume } };
}

function formString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).value === 'string') {
    return ((value as Record<string, unknown>).value as string).trim();
  }
  return '';
}

function remoteStartSuccess(session: ManagedSession): string {
  return `已启动并连接 ${getAgentAdapter(session.agent).displayName} session「${session.id}」。`;
}

function larkStartupError(result: DaemonResult, request: Pick<StartSessionRequest, 'sessionId' | 'agent'>): LarkActionResult {
  const failure = sessionStartupFailure(result, request);
  return failure
    ? { type: 'session-start-failed', content: `${failure.agent} 启动失败。`, failure }
    : { type: 'error', content: remoteError(result) };
}

function remoteError(result: DaemonResult): string {
  if (result.ok) return '操作已完成。';
  const context = result.errorContext ?? {};
  const sessionId = typeof context.sessionId === 'string' ? context.sessionId : '该名称';
  switch (result.errorCode) {
    case 'SESSION_EXISTS': return `无法启动 session「${sessionId}」：该 session 已在运行。请换一个名称，或用 /sessions 连接现有 session。`;
    case 'AGENT_SESSION_IN_USE': {
      const ownerSessionId = typeof context.ownerSessionId === 'string' ? context.ownerSessionId : '现有 session';
      return `无法启动 session「${sessionId}」：该 Agent 原生 session 已由 LCA session「${ownerSessionId}」连接。请用 /sessions 连接现有 session。`;
    }
    case 'AGENT_EXITED_DURING_STARTUP': {
      const agent = typeof context.agent === 'string' ? context.agent : 'Agent';
      const exitStatus = typeof context.exitStatus === 'number' ? `（退出码 ${context.exitStatus}）` : '';
      const excerpt = typeof context.terminalExcerpt === 'string'
        ? context.terminalExcerpt
        : 'Agent 未输出可用错误信息。';
      return `无法启动 session「${sessionId}」：${agent} 启动后立即退出${exitStatus}。\n\n原始错误：\n${excerpt}`;
    }
    case 'AGENT_IDENTITY_TIMEOUT':
      return `无法恢复 session「${sessionId}」：Agent 仍在运行，但未能确认原生 session ID。请重试或启动新会话。`;
    case 'INVALID_SESSION_NAME': return 'Session 名称无效：只能包含字母、数字、下划线和短横线，长度为 1–40 个字符。';
    case 'INVALID_CWD': return `工作目录不可用：${typeof context.cwd === 'string' ? context.cwd : '请填写本机存在的绝对路径'}。`;
    case 'BINARY_NOT_FOUND': return `找不到 Agent 命令：${typeof context.binary === 'string' ? context.binary : '请检查安装与 PATH'}。`;
    case 'INVALID_OPTIONS':
    case 'INVALID_RESUME': return typeof context.reason === 'string' ? context.reason : '启动参数无效，请检查后重试。';
    case 'START_FAILED': return `无法启动 session「${sessionId}」。请检查工作目录、Agent 安装，或在本机运行 lca logs 查看日志。`;
    default: return '操作失败，请稍后重试；可在本机运行 lca status 和 lca logs 检查。';
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
