import {
  createLarkChannel,
  type CardActionEvent,
  type LarkChannel,
  type NormalizedMessage,
} from '@larksuite/channel';
import type { AppConfig, AppSecrets, ManagedSession } from '../core/model.js';
import type { RuntimeStatus } from '../daemon/protocol.js';
import type { ScreenDetection } from '../screen/detector.js';
import type { AgentId } from '../agents/types.js';
import type { ResumePickerView } from '../screen/resume-picker.js';
import type { StartSessionRequest } from '../session/start-request.js';
import type { SessionStartupFailure } from '../session/startup-failure.js';
import { ActionSigner, type SignedAction } from './action-signing.js';
import {
  CHOICE_FORM_SUBMIT_ACTION,
  choiceCard,
  choiceFormSubmitName,
  expiredActionCard,
  handledActionCard,
  interactionInputCard,
  manualControlCard,
  MANUAL_SUBMIT_ACTION,
  MANUAL_TYPE_ACTION,
  SESSION_CREATE_SUBMIT_ACTION,
  sessionCreateCard,
  sessionCreateFailureCard,
  sessionCreateOpenedCard,
  sessionCreateProgressCard,
  sessionCreateResultCard,
  sessionStartupFailureCard,
  type ManualControlView,
  sessionPickerCard,
  resumePickerCard,
  startupConflictCard,
  statusCard,
  stopCard,
} from './cards.js';

export interface LarkGatewayHandler {
  onMessage(message: NormalizedMessage): Promise<void>;
  onAction(event: CardActionEvent, action: SignedAction): Promise<LarkActionResult>;
  onResumePickerDeliveryFailure?(session: ManagedSession): Promise<void>;
}

export type LarkActionResult =
  | { type: 'error'; content: string }
  | { type: 'success'; content: string }
  | { type: 'awaiting-input'; content: string; agent: AgentId; label: string }
  | { type: 'refresh'; content: string; screen: ScreenDetection; paneId: string; agent: AgentId }
  | { type: 'manual'; content: string; view: ManualControlView }
  | { type: 'session-create-form'; content: string; sessions?: ManagedSession[]; activeSessionId?: string }
  | { type: 'session-created'; content: string; session: ManagedSession }
  | { type: 'session-start-failed'; content: string; failure: SessionStartupFailure }
  | { type: 'resume-picker'; content: string; session: ManagedSession; picker: ResumePickerView }
  | { type: 'startup-conflict'; content: string; request: StartSessionRequest; owner: ManagedSession }
  | {
      type: 'session-picker'; content: string; sessions: ManagedSession[]; activeSessionId?: string;
      confirmingStopSessionId?: string;
    };

export interface RemoteGateway {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendText(chatId: string, text: string): Promise<unknown>;
  sendMarkdown(chatId: string, markdown: string): Promise<unknown>;
  sendChoice(chatId: string, paneId: string, screen: ScreenDetection, agent: AgentId): Promise<unknown>;
  updateChoice(messageId: string, chatId: string, paneId: string, screen: ScreenDetection, agent: AgentId): Promise<unknown>;
  completeChoiceInput(messageId: string, action: SignedAction, content: string): Promise<unknown>;
  sendManual(chatId: string, view: ManualControlView): Promise<unknown>;
  sendStatus(chatId: string, status: RuntimeStatus): Promise<unknown>;
  sendSessionPicker(chatId: string, sessions: ManagedSession[], activeSessionId?: string): Promise<unknown>;
  sendResumePicker(chatId: string, session: ManagedSession, picker: ResumePickerView): Promise<unknown>;
  sendStartupConflict(chatId: string, request: StartSessionRequest, owner: ManagedSession): Promise<unknown>;
  sendSessionCreate(chatId: string): Promise<unknown>;
  sendSessionStartupFailure(chatId: string, failure: SessionStartupFailure): Promise<unknown>;
  sendStopConfirmation(chatId: string, paneId: string, fingerprint: string, agent: AgentId): Promise<unknown>;
}

export type GatewayFactory = (config: AppConfig, secrets: AppSecrets, handler: LarkGatewayHandler) => RemoteGateway;

export class LarkGateway implements RemoteGateway {
  private readonly channel: LarkChannel;
  private readonly signer: ActionSigner;
  private readonly formActions = new Map<string, Map<string, SignedAction>>();
  private readonly formActionsInFlight = new Set<string>();

  constructor(config: AppConfig, secrets: AppSecrets, private readonly handler: LarkGatewayHandler) {
    this.signer = new ActionSigner(secrets.callbackSecret);
    this.channel = createLarkChannel({
      appId: config.appId,
      appSecret: secrets.appSecret,
      domain: config.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
      source: 'lark-coding-assistant',
      policy: { dmMode: 'open', requireMention: false, respondToMentionAll: false },
      safety: { chatQueue: { enabled: true, mergeWhileBusy: false } },
      handshakeTimeoutMs: 8_000,
      httpTimeoutMs: 30_000,
      respectProxyEnv: true,
    });
    this.channel.on('message', async (message) => this.handler.onMessage(message));
    this.channel.on('cardAction', async (event) => {
      console.error(`[lca] card action received: tag=${event.action.tag ?? 'unknown'} name=${event.action.name ?? '-'} message=${event.messageId}`);
      const mappedFormAction = event.action.formValue && event.action.name
        ? this.formActions.get(event.messageId)?.get(event.action.name)
        : undefined;
      const action = this.signer.verify(event.action.value, event.chatId)
        ?? (mappedFormAction ? this.signer.verify(mappedFormAction, event.chatId) : undefined);
      if (!action) {
        if (this.formActionsInFlight.has(event.messageId)) {
          return { toast: { type: 'warning', content: '操作正在处理中，请稍候。' } };
        }
        console.error(`[lca] card action rejected: signature or mapping invalid for message=${event.messageId}`);
        void this.markExpiredCard(event);
        return { toast: { type: 'error', content: '卡片或按钮已失效，请获取最新卡片。' } };
      }
      if (event.action.formValue || action.kind === 'manual' || action.kind === 'session-create'
        || action.kind === 'startup-conflict' || action.kind === 'resume-picker'
        || action.kind === 'session-stop' || action.kind === 'session-start-error') {
        if (this.formActionsInFlight.has(event.messageId)) {
          return { toast: { type: 'warning', content: inFlightToast(action) } };
        }
        this.formActionsInFlight.add(event.messageId);
        void this.handleDeferredCardAction(event, action).finally(() => {
          this.formActionsInFlight.delete(event.messageId);
        });
        return { toast: { type: 'success', content: progressToast(action) } };
      }
      const result = await this.handler.onAction(event, action);
      if (result.type === 'error') return { toast: result };
      if (result.type === 'session-create-form') {
        this.rememberSessionCreateFormAction(event.messageId, event.chatId);
        return {
          toast: { type: 'success', content: result.content },
          card: { type: 'raw', data: sessionCreateCard() },
        };
      }
      if (result.type === 'manual') {
        this.rememberManualFormActions(event.messageId, event.chatId, result.view);
        return {
          toast: { type: 'success', content: result.content },
          card: { type: 'raw', data: manualControlCard(event.chatId, result.view, this.signer) },
        };
      }
      if (result.type === 'refresh') {
        this.rememberFormActions(event.messageId, event.chatId, result.paneId, result.screen, result.agent);
        return {
          toast: { type: 'success', content: result.content },
          card: { type: 'raw', data: choiceCard(event.chatId, result.paneId, result.screen, this.signer, result.agent) },
        };
      }
      if (result.type === 'awaiting-input') {
        return {
          toast: { type: 'success', content: result.content },
          card: { type: 'raw', data: interactionInputCard(result.agent, result.label) },
        };
      }
      if (result.type === 'session-created') {
        this.formActions.delete(event.messageId);
        return {
          toast: { type: 'success', content: result.content },
          card: { type: 'raw', data: sessionCreateResultCard(true, result.content, result.session) },
        };
      }
      if (result.type === 'session-start-failed') {
        return {
          toast: { type: 'error', content: result.content },
          card: { type: 'raw', data: sessionStartupFailureCard(event.chatId, result.failure, this.signer) },
        };
      }
      if (result.type === 'resume-picker') {
        return {
          toast: { type: 'success', content: result.content },
          card: { type: 'raw', data: resumePickerCard(event.chatId, result.session, result.picker, this.signer) },
        };
      }
      if (result.type === 'startup-conflict') {
        return {
          toast: { type: 'warning', content: result.content },
          card: { type: 'raw', data: startupConflictCard(event.chatId, requestSession(result.request), result.owner, this.signer) },
        };
      }
      if (result.type === 'session-picker') {
        return {
          toast: { type: 'success', content: result.content },
          card: { type: 'raw', data: sessionPickerCard(
            event.chatId, result.sessions, result.activeSessionId, this.signer, result.confirmingStopSessionId,
          ) },
        };
      }
      return {
        toast: result,
        card: { type: 'raw', data: handledActionCard(action, result.content) },
      };
    });
  }

  private async handleDeferredCardAction(event: CardActionEvent, action: SignedAction): Promise<void> {
    let initialResumePicker: ManagedSession | undefined;
    try {
      if (action.kind === 'session-create' && action.action === 'submit') {
        await this.updateCardAfterAction(event.messageId, sessionCreateProgressCard());
      }
      const result = await this.handler.onAction(event, action);
      if (result.type === 'error') {
        if (action.kind === 'session-create') {
          await this.updateCardAfterAction(
            event.messageId,
            sessionCreateFailureCard(event.chatId, result.content, this.signer),
          );
          this.formActions.delete(event.messageId);
          return;
        }
        await this.channel.send(event.chatId, { text: `卡片操作未完成：${result.content}` });
        return;
      }
      if (result.type === 'session-created') {
        await this.updateCardAfterAction(event.messageId, sessionCreateResultCard(true, result.content, result.session));
        this.formActions.delete(event.messageId);
        return;
      }
      if (result.type === 'session-start-failed') {
        await this.updateCardAfterAction(
          event.messageId,
          sessionStartupFailureCard(event.chatId, result.failure, this.signer),
        );
        this.formActions.delete(event.messageId);
        return;
      }
      if (result.type === 'resume-picker') {
        if (action.kind === 'session-create') initialResumePicker = result.session;
        await this.updateCardAfterAction(event.messageId, resumePickerCard(event.chatId, result.session, result.picker, this.signer));
        return;
      }
      if (result.type === 'startup-conflict') {
        await this.updateCardAfterAction(
          event.messageId,
          startupConflictCard(event.chatId, requestSession(result.request), result.owner, this.signer),
        );
        return;
      }
      if (result.type === 'session-picker') {
        if (action.kind === 'session-start-error') {
          await this.channel.send(event.chatId, { card: sessionPickerCard(
            event.chatId, result.sessions, result.activeSessionId, this.signer, result.confirmingStopSessionId,
          ) });
          return;
        }
        await this.updateCardAfterAction(event.messageId, sessionPickerCard(
          event.chatId, result.sessions, result.activeSessionId, this.signer, result.confirmingStopSessionId,
        ));
        return;
      }
      if (result.type === 'session-create-form') {
        const sent = await this.channel.send(event.chatId, { card: sessionCreateCard() });
        this.rememberSessionCreateFormAction(sent.messageId, event.chatId);
        const sourceCard = action.kind === 'session-create' && result.sessions
          ? sessionPickerCard(event.chatId, result.sessions, result.activeSessionId, this.signer, undefined, false)
          : sessionCreateOpenedCard();
        await this.updateCardAfterAction(event.messageId, sourceCard).catch(async (error) => {
          const detail = cardErrorDetail(error);
          console.error(`[lca] failed to retire session-create source card: message=${event.messageId} detail=${detail}`);
          await this.channel.send(event.chatId, {
            text: '新建表单已发送，但原卡片状态更新失败；请使用最新的“新建 Coding Session”卡片继续操作。',
          }).catch(() => undefined);
        });
        return;
      }
      if (result.type === 'refresh') {
        await this.updateCardAfterAction(
          event.messageId,
          choiceCard(event.chatId, result.paneId, result.screen, this.signer, result.agent),
        );
        this.rememberFormActions(event.messageId, event.chatId, result.paneId, result.screen, result.agent);
        return;
      }
      if (result.type === 'manual') {
        await this.updateCardAfterAction(event.messageId, manualControlCard(event.chatId, result.view, this.signer));
        this.rememberManualFormActions(event.messageId, event.chatId, result.view);
        return;
      }
      if (result.type === 'awaiting-input') {
        await this.updateCardAfterAction(event.messageId, interactionInputCard(result.agent, result.label));
        return;
      }
      await this.updateCardAfterAction(event.messageId, handledActionCard(action, result.content));
    } catch (error) {
      const detail = cardErrorDetail(error);
      if (initialResumePicker) {
        await this.handler.onResumePickerDeliveryFailure?.(initialResumePicker).catch((cleanupError) => {
          console.error(`[lca] resume picker rollback failed: session=${initialResumePicker?.id} detail=${cardErrorDetail(cleanupError)}`);
        });
      }
      if (action.kind === 'session-create') this.formActions.delete(event.messageId);
      console.error(`[lca] deferred card action failed: kind=${action.kind} action=${action.action} message=${event.messageId} detail=${detail}`);
      await this.channel.send(event.chatId, {
        text: action.kind === 'session-create'
          ? `新建 Session 表单打开失败：${detail}。请重新发送 /sessions，或直接使用 /start 命令。`
          : `卡片操作同步失败：${detail}`,
      }).catch(() => undefined);
    }
  }

  private async updateCardAfterAction(messageId: string, card: object): Promise<void> {
    const retryDelays = [0, 300, 800, 1_600];
    let lastError: unknown;
    for (const delay of retryDelays) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await this.channel.updateCard(messageId, card);
        return;
      } catch (error) {
        lastError = error;
        if (!cardActionLocked(error)) throw error;
      }
    }
    throw lastError;
  }

  private async markExpiredCard(event: CardActionEvent): Promise<void> {
    try {
      await this.updateCardAfterAction(event.messageId, expiredActionCard());
    } catch (error) {
      const detail = cardErrorDetail(error);
      console.error(`[lca] failed to mark expired card: message=${event.messageId} detail=${detail}`);
      await this.channel.send(event.chatId, {
        text: '卡片或按钮已失效，请重新发送对应命令获取最新卡片；Session 相关操作可发送 /sessions。',
      }).catch(() => undefined);
    }
  }

  connect(): Promise<void> {
    return this.channel.connect();
  }

  disconnect(): Promise<void> {
    return this.channel.disconnect();
  }

  sendText(chatId: string, text: string): Promise<unknown> {
    return this.channel.send(chatId, { text });
  }

  sendMarkdown(chatId: string, markdown: string): Promise<unknown> {
    return this.channel.send(chatId, { markdown });
  }

  async sendChoice(chatId: string, paneId: string, screen: ScreenDetection, agent: AgentId): Promise<unknown> {
    const result = await this.channel.send(chatId, { card: choiceCard(chatId, paneId, screen, this.signer, agent) });
    this.rememberFormActions(result.messageId, chatId, paneId, screen, agent);
    return result;
  }

  async updateChoice(messageId: string, chatId: string, paneId: string, screen: ScreenDetection, agent: AgentId): Promise<void> {
    await this.channel.updateCard(messageId, choiceCard(chatId, paneId, screen, this.signer, agent));
    this.rememberFormActions(messageId, chatId, paneId, screen, agent);
  }

  async completeChoiceInput(messageId: string, action: SignedAction, content: string): Promise<void> {
    await this.channel.updateCard(messageId, handledActionCard(action, content));
    this.formActions.delete(messageId);
  }

  async sendManual(chatId: string, view: ManualControlView): Promise<unknown> {
    const result = await this.channel.send(chatId, { card: manualControlCard(chatId, view, this.signer) });
    this.rememberManualFormActions(result.messageId, chatId, view);
    return result;
  }

  private rememberManualFormActions(messageId: string, chatId: string, view: ManualControlView): void {
    if (view.state === 'recovered' || view.state === 'exited') {
      this.formActions.delete(messageId);
      return;
    }
    const common = {
      kind: 'manual' as const,
      sessionId: view.session.id,
      manualMode: view.mode ?? 'fallback',
      agent: view.session.agent,
      paneId: view.session.paneId,
      fingerprint: view.screen.fingerprint,
      chatId,
    };
    this.formActions.set(messageId, new Map([
      [MANUAL_TYPE_ACTION, this.signer.sign({ ...common, action: MANUAL_TYPE_ACTION }, 10 * 60_000)],
      [MANUAL_SUBMIT_ACTION, this.signer.sign({ ...common, action: MANUAL_SUBMIT_ACTION }, 10 * 60_000)],
    ]));
  }

  private rememberSessionCreateFormAction(messageId: string, chatId: string): void {
    this.formActions.set(messageId, new Map([[
      SESSION_CREATE_SUBMIT_ACTION,
      this.signer.sign({
        kind: 'session-create', agent: 'codex', action: 'submit', paneId: '', fingerprint: 'create', chatId,
      }, 10 * 60_000),
    ]]));
  }

  private rememberFormActions(
    messageId: string,
    chatId: string,
    paneId: string,
    screen: ScreenDetection,
    agent: AgentId,
  ): void {
    if (screen.interaction?.semantics?.activation !== 'toggle') {
      this.formActions.delete(messageId);
      return;
    }
    const actions = new Map<string, SignedAction>();
    actions.set(choiceFormSubmitName(), this.signer.sign({
      kind: 'choice',
      interactionKind: screen.interaction?.kind,
      agent,
      action: CHOICE_FORM_SUBMIT_ACTION,
      paneId,
      fingerprint: screen.interaction?.revision ?? screen.fingerprint,
      chatId,
    }));
    this.formActions.set(messageId, actions);
    while (this.formActions.size > 256) {
      const oldest = this.formActions.keys().next().value;
      if (!oldest) break;
      this.formActions.delete(oldest);
    }
  }

  sendStatus(chatId: string, status: RuntimeStatus): Promise<unknown> {
    return this.channel.send(chatId, { card: statusCard(status) });
  }

  sendSessionPicker(chatId: string, sessions: ManagedSession[], activeSessionId?: string): Promise<unknown> {
    return this.channel.send(chatId, { card: sessionPickerCard(chatId, sessions, activeSessionId, this.signer) });
  }

  sendResumePicker(chatId: string, session: ManagedSession, picker: ResumePickerView): Promise<unknown> {
    return this.channel.send(chatId, { card: resumePickerCard(chatId, session, picker, this.signer) });
  }

  sendStartupConflict(chatId: string, request: StartSessionRequest, owner: ManagedSession): Promise<unknown> {
    return this.channel.send(chatId, { card: startupConflictCard(chatId, requestSession(request), owner, this.signer) });
  }

  async sendSessionCreate(chatId: string): Promise<unknown> {
    const result = await this.channel.send(chatId, { card: sessionCreateCard() });
    this.rememberSessionCreateFormAction(result.messageId, chatId);
    return result;
  }

  sendSessionStartupFailure(chatId: string, failure: SessionStartupFailure): Promise<unknown> {
    return this.channel.send(chatId, { card: sessionStartupFailureCard(chatId, failure, this.signer) });
  }

  sendStopConfirmation(chatId: string, paneId: string, fingerprint: string, agent: AgentId): Promise<unknown> {
    return this.channel.send(chatId, { card: stopCard(chatId, paneId, fingerprint, this.signer, agent) });
  }
}

function requestSession(request: StartSessionRequest): Pick<ManagedSession, 'id' | 'agent' | 'cwd'> {
  return { id: request.sessionId, agent: request.agent, cwd: request.cwd };
}

function cardActionLocked(error: unknown): boolean {
  if (typeof error === 'string') return /card action is lock/i.test(error);
  if (error instanceof Error && /card action is lock/i.test(error.message)) return true;
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  return ['message', 'msg', 'cause'].some((key) => cardActionLocked(record[key]));
}

function progressToast(action: SignedAction): string {
  if (action.kind === 'manual') return '正在操作本地终端…';
  if (action.kind === 'session-create') return action.action === 'open' ? '正在打开新建表单…' : '正在启动 Session…';
  if (action.kind === 'resume-picker') return action.action.startsWith('select:') ? '正在恢复 Session…' : '正在更新 Resume Picker…';
  if (action.kind === 'startup-conflict') return action.action === 'new' ? '正在启动新 Session…' : '正在处理 Session 冲突…';
  if (action.kind === 'session-stop') return '正在处理 Session…';
  if (action.kind === 'session-start-error') return action.action === 'create' ? '正在打开新建表单…' : '正在打开 Sessions…';
  return '正在提交到本地终端…';
}

function inFlightToast(action: SignedAction): string {
  if (action.kind === 'manual') return '终端操作正在执行，请稍候。';
  if (action.kind === 'session-create') return action.action === 'open' ? '正在打开新建表单，请稍候。' : 'Session 正在启动，请稍候。';
  if (action.kind === 'resume-picker') return 'Resume Picker 操作正在执行，请稍候。';
  if (action.kind === 'startup-conflict') return 'Session 冲突操作正在执行，请稍候。';
  if (action.kind === 'session-stop') return 'Session 操作正在执行，请稍候。';
  if (action.kind === 'session-start-error') return '正在处理启动失败操作，请稍候。';
  return '答案正在提交，请稍候。';
}

function cardErrorDetail(error: unknown): string {
  const response = error && typeof error === 'object' ? (error as Record<string, unknown>).response : undefined;
  const data = response && typeof response === 'object' ? (response as Record<string, unknown>).data : undefined;
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : undefined;
  const code = typeof record?.code === 'number' || typeof record?.code === 'string' ? String(record.code) : undefined;
  const message = typeof record?.msg === 'string'
    ? record.msg
    : error instanceof Error ? error.message : String(error);
  const sanitized = message
    .replace(/(?:authorization\s*:\s*bearer|bearer)\s+[^\s,'"\]}]+/gi, 'Bearer [REDACTED]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 1200);
  return code ? `code=${code} ${sanitized}` : sanitized;
}
