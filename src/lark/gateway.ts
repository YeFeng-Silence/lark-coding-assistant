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
import { ActionSigner, type SignedAction } from './action-signing.js';
import {
  CHOICE_FORM_SUBMIT_ACTION,
  choiceCard,
  choiceFormSubmitName,
  handledActionCard,
  interactionInputCard,
  manualControlCard,
  MANUAL_SUBMIT_ACTION,
  MANUAL_TYPE_ACTION,
  type ManualControlView,
  sessionPickerCard,
  statusCard,
  stopCard,
} from './cards.js';

export interface LarkGatewayHandler {
  onMessage(message: NormalizedMessage): Promise<void>;
  onAction(event: CardActionEvent, action: SignedAction): Promise<LarkActionResult>;
}

export type LarkActionResult =
  | { type: 'error'; content: string }
  | { type: 'success'; content: string }
  | { type: 'awaiting-input'; content: string; agent: AgentId; label: string }
  | { type: 'refresh'; content: string; screen: ScreenDetection; paneId: string; agent: AgentId }
  | { type: 'manual'; content: string; view: ManualControlView };

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
      const mappedFormAction = event.action.formValue && event.action.name
        ? this.formActions.get(event.messageId)?.get(event.action.name)
        : undefined;
      const action = this.signer.verify(event.action.value, event.chatId)
        ?? (mappedFormAction ? this.signer.verify(mappedFormAction, event.chatId) : undefined);
      if (!action) return { toast: { type: 'error', content: '操作已失效，请等待新卡片。' } };
      if (event.action.formValue || action.kind === 'manual') {
        if (this.formActionsInFlight.has(event.messageId)) {
          return { toast: { type: 'warning', content: action.kind === 'manual' ? '终端操作正在执行，请稍候。' : '答案正在提交，请稍候。' } };
        }
        this.formActionsInFlight.add(event.messageId);
        void this.handleDeferredCardAction(event, action).finally(() => {
          this.formActionsInFlight.delete(event.messageId);
        });
        return { toast: { type: 'success', content: action.kind === 'manual' ? '正在操作本地终端…' : '正在提交到本地终端…' } };
      }
      const result = await this.handler.onAction(event, action);
      if (result.type === 'error') return { toast: result };
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
      return {
        toast: result,
        card: { type: 'raw', data: handledActionCard(action, result.content) },
      };
    });
  }

  private async handleDeferredCardAction(event: CardActionEvent, action: SignedAction): Promise<void> {
    try {
      const result = await this.handler.onAction(event, action);
      if (result.type === 'error') {
        await this.channel.send(event.chatId, { text: `卡片操作未完成：${result.content}` });
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
      const detail = error instanceof Error ? error.message : String(error);
      await this.channel.send(event.chatId, { text: `卡片操作同步失败：${detail}` }).catch(() => undefined);
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

  sendStopConfirmation(chatId: string, paneId: string, fingerprint: string, agent: AgentId): Promise<unknown> {
    return this.channel.send(chatId, { card: stopCard(chatId, paneId, fingerprint, this.signer, agent) });
  }
}

function cardActionLocked(error: unknown): boolean {
  if (typeof error === 'string') return /card action is lock/i.test(error);
  if (error instanceof Error && /card action is lock/i.test(error.message)) return true;
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  return ['message', 'msg', 'cause'].some((key) => cardActionLocked(record[key]));
}
