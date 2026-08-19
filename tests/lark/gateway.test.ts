import { describe, expect, it, vi } from 'vitest';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import type { LarkActionResult, LarkGatewayHandler } from '../../src/lark/gateway.js';
import type { SignedAction } from '../../src/lark/action-signing.js';
import { detectClaudeScreen } from '../../src/screen/detector.js';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown) => unknown>();
  return {
    listeners,
    send: vi.fn(async () => ({ messageId: 'om_form' })),
    updateCard: vi.fn(async () => undefined),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
  };
});

vi.mock('@larksuite/channel', () => ({
  createLarkChannel: () => ({
    on: (name: string, listener: (event: unknown) => unknown) => mocks.listeners.set(name, listener),
    send: mocks.send,
    updateCard: mocks.updateCard,
    connect: mocks.connect,
    disconnect: mocks.disconnect,
  }),
}));

describe('LarkGateway form callbacks', () => {
  it('acknowledges immediately and updates the original card after terminal synchronization', async () => {
    const { LarkGateway } = await import('../../src/lark/gateway.js');
    let finishAction: ((result: LarkActionResult) => void) | undefined;
    const handler: LarkGatewayHandler = {
      onMessage: async (_message: NormalizedMessage) => undefined,
      onAction: vi.fn(async (_event: CardActionEvent, _action: SignedAction) => new Promise<LarkActionResult>((resolve) => {
        finishAction = resolve;
      })),
    };
    const gateway = new LarkGateway(
      {
        tenant: 'feishu', appId: 'app', tmuxBinary: 'tmux', pollIntervalMs: 100,
        agentBinaries: { codex: 'codex', 'trae-cli': 'trae-cli', 'claude-code': 'claude' },
      },
      { appSecret: 'secret', callbackSecret: 'callback' },
      handler,
    );
    const screen = detectClaudeScreen(`────────────────────────────────────────
←  ☐ 回归  ✔ Submit  →
请选择能力
❯ 1. [ ] Read
  Read files only.
  2. [ ] Edit
  Modify files.
  3. [ ] Type something
     Submit
Enter to select · ↑/↓ to navigate · Esc to cancel`);
    await gateway.sendChoice('oc_1', '%1', screen, 'claude-code');
    const listener = mocks.listeners.get('cardAction');
    expect(listener).toBeDefined();

    const response = await listener?.({
      messageId: 'om_form', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: {
        value: undefined, tag: 'button', name: 'choice_form_submit',
        formValue: { choice_selected_0: true, choice_selected_1: false, choice_selected_2: true, custom_input_2: 'new value' },
      },
    });

    expect(response).toEqual({ toast: { type: 'success', content: '正在提交到本地终端…' } });
    expect(mocks.updateCard).not.toHaveBeenCalled();
    finishAction?.({ type: 'refresh', content: '已选择', screen, paneId: '%1', agent: 'claude-code' });
    await vi.waitFor(() => expect(mocks.updateCard).toHaveBeenCalledWith('om_form', expect.any(Object)));
  });

  it('acknowledges manual text submission and refreshes the same remote-control card', async () => {
    mocks.updateCard.mockClear();
    mocks.updateCard.mockRejectedValueOnce(new Error('card action is lock')).mockResolvedValueOnce(undefined);
    const { LarkGateway } = await import('../../src/lark/gateway.js');
    let finishAction: ((result: LarkActionResult) => void) | undefined;
    const handler: LarkGatewayHandler = {
      onMessage: async (_message: NormalizedMessage) => undefined,
      onAction: vi.fn(async () => new Promise<LarkActionResult>((resolve) => { finishAction = resolve; })),
    };
    const gateway = new LarkGateway(
      {
        tenant: 'feishu', appId: 'app', tmuxBinary: 'tmux', pollIntervalMs: 100,
        agentBinaries: { codex: 'codex', 'trae-cli': 'trae-cli', 'claude-code': 'claude' },
      },
      { appSecret: 'secret', callbackSecret: 'callback' },
      handler,
    );
    const session = {
      id: 'assistant', agent: 'codex' as const, sessionName: 'lca-assistant', paneId: '%7',
      cwd: '/tmp', agentVersion: 'test', updatedAt: 1,
    };
    const screen = {
      state: 'unknown' as const, confidence: 0.4, normalized: 'unknown prompt', fingerprint: 'manual-fp',
      evidence: [], actions: [], hasDraftInput: false,
    };
    const view = { session, screen, output: 'unknown prompt', capturedAt: new Date() };
    await gateway.sendManual('oc_1', view);
    const listener = mocks.listeners.get('cardAction');
    const response = await listener?.({
      messageId: 'om_form', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: { value: undefined, tag: 'button', name: 'submit', formValue: { manual_text: 'answer' } },
    });
    expect(response).toEqual({ toast: { type: 'success', content: '正在操作本地终端…' } });
    finishAction?.({ type: 'manual', content: '输入文本并提交已执行。', view: { ...view, lastOperation: '输入文本并提交' } });
    await vi.waitFor(() => expect(mocks.updateCard).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    expect(mocks.updateCard).toHaveBeenLastCalledWith('om_form', expect.any(Object));
  });

  it('refreshes the signed manual form action after each in-place card update', async () => {
    mocks.send.mockClear();
    mocks.updateCard.mockClear();
    const { LarkGateway } = await import('../../src/lark/gateway.js');
    const actions: SignedAction[] = [];
    const session = {
      id: 'assistant', agent: 'codex' as const, sessionName: 'lca-assistant', paneId: '%7',
      cwd: '/tmp', agentVersion: 'test', updatedAt: 1,
    };
    const screen = {
      state: 'unknown' as const, confidence: 0.4, normalized: 'unknown prompt', fingerprint: 'manual-fp-1',
      evidence: [], actions: [], hasDraftInput: false,
    };
    const handler: LarkGatewayHandler = {
      onMessage: async () => undefined,
      onAction: vi.fn(async (_event, action) => {
        actions.push(action);
        return {
          type: 'manual' as const,
          content: '已执行',
          view: { session, screen: { ...screen, fingerprint: 'manual-fp-2' }, output: 'updated', capturedAt: new Date() },
        };
      }),
    };
    const gateway = new LarkGateway(
      {
        tenant: 'feishu', appId: 'app', tmuxBinary: 'tmux', pollIntervalMs: 100,
        agentBinaries: { codex: 'codex', 'trae-cli': 'trae-cli', 'claude-code': 'claude' },
      },
      { appSecret: 'secret', callbackSecret: 'callback' },
      handler,
    );
    await gateway.sendManual('oc_1', { session, screen, output: 'initial', capturedAt: new Date() });
    const listener = mocks.listeners.get('cardAction');
    await listener?.({
      messageId: 'om_form', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: { value: undefined, tag: 'button', name: 'submit', formValue: { manual_text: 'first' } },
    });
    await vi.waitFor(() => expect(actions).toHaveLength(1));
    await vi.waitFor(() => expect(mocks.updateCard).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await listener?.({
      messageId: 'om_form', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: { value: undefined, tag: 'button', name: 'submit', formValue: { manual_text: 'second' } },
    });
    await vi.waitFor(() => expect(actions).toHaveLength(2));
    expect(actions.map(({ fingerprint }) => fingerprint)).toEqual(['manual-fp-1', 'manual-fp-2']);
  });

  it('acknowledges a manual close immediately and explicitly updates the original card', async () => {
    mocks.send.mockClear();
    mocks.updateCard.mockClear();
    const { LarkGateway } = await import('../../src/lark/gateway.js');
    const session = {
      id: 'assistant', agent: 'codex' as const, sessionName: 'lca-assistant', paneId: '%7',
      cwd: '/tmp', agentVersion: 'test', updatedAt: 1,
    };
    const screen = {
      state: 'unknown' as const, confidence: 0.4, normalized: 'unknown prompt', fingerprint: 'manual-fp',
      evidence: [], actions: [], hasDraftInput: false,
    };
    const view = { session, screen, output: 'unknown prompt', capturedAt: new Date(), mode: 'explicit' as const };
    const handler: LarkGatewayHandler = {
      onMessage: async () => undefined,
      onAction: vi.fn(async () => ({
        type: 'manual' as const, content: '已结束手动遥控。', view: { ...view, state: 'exited' as const },
      })),
    };
    const gateway = new LarkGateway(
      {
        tenant: 'feishu', appId: 'app', tmuxBinary: 'tmux', pollIntervalMs: 100,
        agentBinaries: { codex: 'codex', 'trae-cli': 'trae-cli', 'claude-code': 'claude' },
      },
      { appSecret: 'secret', callbackSecret: 'callback' },
      handler,
    );
    await gateway.sendManual('oc_1', view);
    const sendCalls = mocks.send.mock.calls as unknown as Array<[string, { card: unknown }]>;
    const sentCard = sendCalls.at(-1)?.[1].card;
    const closeAction = findCallbackValue(sentCard, '结束遥控');
    const listener = mocks.listeners.get('cardAction');
    const response = await listener?.({
      messageId: 'om_form', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: { value: closeAction, tag: 'button' },
    });
    expect(response).toEqual({ toast: { type: 'success', content: '正在操作本地终端…' } });
    await vi.waitFor(() => expect(mocks.updateCard).toHaveBeenCalledWith('om_form', expect.any(Object)));
  });
});

function findCallbackValue(value: unknown, label: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const text = record.text as Record<string, unknown> | undefined;
  if (text?.content === label) {
    const behaviors = record.behaviors as Array<Record<string, unknown>> | undefined;
    return behaviors?.[0]?.value;
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findCallbackValue(item, label);
        if (found) return found;
      }
    } else {
      const found = findCallbackValue(child, label);
      if (found) return found;
    }
  }
  return undefined;
}
