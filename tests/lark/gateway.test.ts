import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  beforeEach(() => {
    mocks.send.mockClear();
    mocks.updateCard.mockClear();
    mocks.updateCard.mockResolvedValue(undefined);
  });

  it('replaces an expired card with a persistent recovery hint', async () => {
    const { LarkGateway } = await import('../../src/lark/gateway.js');
    const handler: LarkGatewayHandler = {
      onMessage: async () => undefined,
      onAction: vi.fn(async () => ({ type: 'success' as const, content: 'unexpected' })),
    };
    new LarkGateway(
      {
        tenant: 'feishu', appId: 'app', tmuxBinary: 'tmux', pollIntervalMs: 100,
        agentBinaries: { codex: 'codex', 'traex': 'traex', 'claude': 'claude' },
      },
      { appSecret: 'secret', callbackSecret: 'callback' }, handler,
    );
    const listener = mocks.listeners.get('cardAction');
    const response = await listener?.({
      messageId: 'om_expired', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: { value: { invalid: true }, tag: 'button' },
    });
    expect(response).toEqual({ toast: { type: 'error', content: '卡片或按钮已失效，请获取最新卡片。' } });
    await vi.waitFor(() => expect(mocks.updateCard).toHaveBeenCalledTimes(1));
    const card = (mocks.updateCard.mock.calls as unknown as Array<[string, unknown]>)[0]?.[1];
    expect(JSON.stringify(card)).toContain('卡片已失效');
    expect(handler.onAction).not.toHaveBeenCalled();
  });

  it('sends a text hint when an expired card can no longer be updated', async () => {
    mocks.updateCard.mockRejectedValue(new Error('message cannot update'));
    const { LarkGateway } = await import('../../src/lark/gateway.js');
    const handler: LarkGatewayHandler = {
      onMessage: async () => undefined,
      onAction: vi.fn(async () => ({ type: 'success' as const, content: 'unexpected' })),
    };
    new LarkGateway(
      {
        tenant: 'feishu', appId: 'app', tmuxBinary: 'tmux', pollIntervalMs: 100,
        agentBinaries: { codex: 'codex', 'traex': 'traex', 'claude': 'claude' },
      },
      { appSecret: 'secret', callbackSecret: 'callback' }, handler,
    );
    const listener = mocks.listeners.get('cardAction');
    await listener?.({
      messageId: 'om_expired', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: { value: undefined, tag: 'button' },
    });
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith('oc_1', expect.objectContaining({
      text: expect.stringContaining('卡片或按钮已失效'),
    })));
  });

  it('opens, submits, and replaces the new-session form with a durable result', async () => {
    mocks.send.mockClear();
    mocks.updateCard.mockClear();
    const { LarkGateway } = await import('../../src/lark/gateway.js');
    const session = {
      id: 'remote', agent: 'traex' as const, sessionName: 'lark-coding-assistant-remote', paneId: '%8',
      cwd: '/work/app', agentVersion: 'test', updatedAt: 1,
    };
    const handler: LarkGatewayHandler = {
      onMessage: async () => undefined,
      onAction: vi.fn(async (_event, action) => action.action === 'open'
        ? { type: 'session-create-form' as const, content: '请填写启动信息。', sessions: [session], activeSessionId: undefined }
        : { type: 'session-created' as const, content: '已启动并连接 traex session「remote」。', session }),
    };
    const gateway = new LarkGateway(
      {
        tenant: 'feishu', appId: 'app', tmuxBinary: 'tmux', pollIntervalMs: 100,
        agentBinaries: { codex: 'codex', 'traex': 'traex', 'claude': 'claude' },
      },
      { appSecret: 'secret', callbackSecret: 'callback' }, handler,
    );
    await gateway.sendSessionPicker('oc_1', [], undefined);
    const sendCalls = mocks.send.mock.calls as unknown as Array<[string, { card: unknown }]>;
    const sentCard = sendCalls.at(-1)?.[1].card;
    const openAction = findCallbackValue(sentCard, '＋ 新建 Session');
    const listener = mocks.listeners.get('cardAction');
    const openResponse = await listener?.({
      messageId: 'om_form', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: { value: openAction, tag: 'button' },
    });
    expect(openResponse).toEqual({ toast: { type: 'success', content: '正在打开新建表单…' } });
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    const formCard = (mocks.send.mock.calls as unknown as Array<[string, { card: unknown }]>).at(-1)?.[1].card;
    expect(formCard).toEqual(expect.objectContaining({
      header: expect.objectContaining({ title: expect.objectContaining({ content: '新建 Coding Session' }) }),
    }));
    await vi.waitFor(() => expect(mocks.updateCard).toHaveBeenCalledTimes(1));
    const retiredCard = (mocks.updateCard.mock.calls as unknown as Array<[string, unknown]>)[0]?.[1];
    expect(JSON.stringify(retiredCard)).toContain('选择 Coding Session');
    expect(JSON.stringify(retiredCard)).toContain('remote');
    expect(JSON.stringify(retiredCard)).toContain('连接 remote');
    expect(JSON.stringify(retiredCard)).not.toContain('＋ 新建 Session');
    await new Promise((resolve) => setTimeout(resolve, 0));
    mocks.updateCard.mockClear();

    const submitResponse = await listener?.({
      messageId: 'om_form', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: {
        value: undefined, tag: 'button', name: 'session_create_submit',
        formValue: { session_name: 'remote', session_agent: 'traex', session_cwd: '/work/app', session_resume: 'new' },
      },
    });
    expect(submitResponse).toEqual({ toast: { type: 'success', content: '正在启动 Session…' } });
    await vi.waitFor(() => expect(mocks.updateCard).toHaveBeenCalledWith('om_form', expect.objectContaining({
      header: expect.objectContaining({ template: 'green' }),
    })));
  });

  it('updates the sessions card in place for close confirmation and completion', async () => {
    const { LarkGateway } = await import('../../src/lark/gateway.js');
    const session = {
      id: 'assistant', agent: 'codex' as const, sessionName: 'lark-coding-assistant-assistant', paneId: '%7',
      cwd: '/work/app', agentVersion: 'test', updatedAt: 1,
    };
    const handler: LarkGatewayHandler = {
      onMessage: async () => undefined,
      onAction: vi.fn(async (_event, action) => action.action === 'request'
        ? {
            type: 'session-picker' as const, content: '请确认是否关闭 assistant。',
            sessions: [session], activeSessionId: 'assistant', confirmingStopSessionId: 'assistant',
          }
        : {
            type: 'session-picker' as const, content: '已关闭 assistant。',
            sessions: [], activeSessionId: undefined,
          }),
    };
    const gateway = new LarkGateway(
      {
        tenant: 'feishu', appId: 'app', tmuxBinary: 'tmux', pollIntervalMs: 100,
        agentBinaries: { codex: 'codex', 'traex': 'traex', 'claude': 'claude' },
      },
      { appSecret: 'secret', callbackSecret: 'callback' }, handler,
    );
    await gateway.sendSessionPicker('oc_1', [session], 'assistant');
    const sendCalls = mocks.send.mock.calls as unknown as Array<[string, { card: unknown }]>;
    const stopAction = findCallbackValue(sendCalls.at(-1)?.[1].card, '关闭');
    const listener = mocks.listeners.get('cardAction');
    const requestResponse = await listener?.({
      messageId: 'om_form', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: { value: stopAction, tag: 'button' },
    });
    expect(requestResponse).toEqual({ toast: { type: 'success', content: '正在处理 Session…' } });
    await vi.waitFor(() => expect(mocks.updateCard).toHaveBeenCalledTimes(1));
    const updateCalls = mocks.updateCard.mock.calls as unknown as Array<[string, unknown]>;
    const confirmationCard = updateCalls.at(-1)?.[1];
    expect(JSON.stringify(confirmationCard)).toContain('确认关闭');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const confirmAction = findCallbackValue(confirmationCard, '确认关闭');
    const confirmResponse = await listener?.({
      messageId: 'om_form', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: { value: confirmAction, tag: 'button' },
    });
    expect(confirmResponse).toEqual({ toast: { type: 'success', content: '正在处理 Session…' } });
    await vi.waitFor(() => expect(mocks.updateCard).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(updateCalls.at(-1)?.[1])).toContain('暂无可连接的 Coding Session');
  });

  it('renders raw startup errors with fresh recovery actions', async () => {
    const { LarkGateway } = await import('../../src/lark/gateway.js');
    const handler: LarkGatewayHandler = {
      onMessage: async () => undefined,
      onAction: vi.fn(async (_event, action) => action.kind === 'session-start-error'
        || (action.kind === 'session-create' && action.action === 'open')
        ? {
            type: 'session-create-form' as const, content: '请填写启动信息。',
            ...(action.kind === 'session-create' ? { sessions: [], activeSessionId: undefined } : {}),
          }
        : {
            type: 'session-start-failed' as const,
            content: 'codex 启动失败。',
            failure: {
              sessionId: 'test5', agent: 'codex' as const, exitStatus: 1,
              terminalExcerpt: 'Error: thread already has an active writer',
            },
          }),
    };
    const gateway = new LarkGateway(
      {
        tenant: 'feishu', appId: 'app', tmuxBinary: 'tmux', pollIntervalMs: 100,
        agentBinaries: { codex: 'codex', 'traex': 'traex', 'claude': 'claude' },
      },
      { appSecret: 'secret', callbackSecret: 'callback' }, handler,
    );
    await gateway.sendSessionPicker('oc_1', [], undefined);
    const originalSessionsCard = (mocks.send.mock.calls as unknown as Array<[string, { card?: unknown }]>)[0]?.[1].card;
    const originalCreateAction = findCallbackValue(originalSessionsCard, '＋ 新建 Session');
    const listener = mocks.listeners.get('cardAction');
    const openResponse = await listener?.({
      messageId: 'om_sessions', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: { value: originalCreateAction, tag: 'button' },
    });
    expect(openResponse).toEqual({ toast: { type: 'success', content: '正在打开新建表单…' } });
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocks.updateCard).toHaveBeenCalledTimes(1));
    const sourceCard = JSON.stringify((mocks.updateCard.mock.calls as unknown as Array<[string, unknown]>)[0]?.[1]);
    expect(sourceCard).toContain('选择 Coding Session');
    expect(sourceCard).toContain('新建 Session 表单已发送');
    expect(sourceCard).not.toContain('＋ 新建 Session');

    const submitResponse = await listener?.({
      messageId: 'om_form', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: {
        value: undefined, tag: 'button', name: 'session_create_submit',
        formValue: { session_name: 'test5', session_agent: 'codex', session_cwd: '/work', session_resume: 'new' },
      },
    });
    expect(submitResponse).toEqual({ toast: { type: 'success', content: '正在启动 Session…' } });
    await vi.waitFor(() => expect(mocks.updateCard).toHaveBeenCalledTimes(3));
    const updates = mocks.updateCard.mock.calls as unknown as Array<[string, unknown]>;
    const failureCard = updates.at(-1)?.[1];
    expect(JSON.stringify(failureCard)).toContain('Error: thread already has an active writer');
    const reopenAction = findCallbackValue(failureCard, '新建 Session');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reopenResponse = await listener?.({
      messageId: 'om_form', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: { value: reopenAction, tag: 'button' },
    });
    expect(reopenResponse).toEqual({ toast: { type: 'success', content: '正在打开新建表单…' } });
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(mocks.updateCard).toHaveBeenCalledTimes(4));
    const sends = mocks.send.mock.calls as unknown as Array<[string, { card?: unknown }]>;
    expect(JSON.stringify(sends.at(-1)?.[1].card)).toContain('新建 Coding Session');
  });

  it('renders the same recovery actions for validation failures', async () => {
    const { LarkGateway } = await import('../../src/lark/gateway.js');
    const handler: LarkGatewayHandler = {
      onMessage: async () => undefined,
      onAction: vi.fn(async () => ({ type: 'error' as const, content: '工作目录不可用。' })),
    };
    const gateway = new LarkGateway(
      {
        tenant: 'feishu', appId: 'app', tmuxBinary: 'tmux', pollIntervalMs: 100,
        agentBinaries: { codex: 'codex', 'traex': 'traex', 'claude': 'claude' },
      },
      { appSecret: 'secret', callbackSecret: 'callback' }, handler,
    );
    await gateway.sendSessionCreate('oc_1');
    const listener = mocks.listeners.get('cardAction');
    await listener?.({
      messageId: 'om_form', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: {
        value: undefined, tag: 'button', name: 'session_create_submit',
        formValue: { session_name: 'bad', session_agent: 'codex', session_cwd: 'relative', session_resume: 'new' },
      },
    });
    await vi.waitFor(() => expect(mocks.updateCard).toHaveBeenCalledTimes(2));
    const updates = mocks.updateCard.mock.calls as unknown as Array<[string, unknown]>;
    const serialized = JSON.stringify(updates.at(-1)?.[1]);
    expect(serialized).toContain('工作目录不可用');
    expect(serialized).toContain('新建 Session');
    expect(serialized).toContain('查看 Sessions');
  });

  it('rolls back an initial Resume Picker when its card cannot be delivered', async () => {
    mocks.updateCard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('invalid card payload'));
    const { LarkGateway } = await import('../../src/lark/gateway.js');
    const session = {
      id: 'restore', agent: 'codex' as const, sessionName: 'lca-restore', paneId: '%9',
      cwd: '/work', agentVersion: 'test', updatedAt: 1,
    };
    const rollback = vi.fn(async () => undefined);
    const handler: LarkGatewayHandler = {
      onMessage: async () => undefined,
      onAction: vi.fn(async () => ({
        type: 'resume-picker' as const, content: '请选择', session,
        picker: {
          agent: 'codex' as const, fingerprint: 'picker', selectedIndex: 0,
          options: [{ id: 'one', label: '历史会话', selected: true, visibleIndex: 0 }],
          canPrevious: false, canNext: false,
        },
      })),
      onResumePickerDeliveryFailure: rollback,
    };
    const gateway = new LarkGateway(
      {
        tenant: 'feishu', appId: 'app', tmuxBinary: 'tmux', pollIntervalMs: 100,
        agentBinaries: { codex: 'codex', 'traex': 'traex', 'claude': 'claude' },
      },
      { appSecret: 'secret', callbackSecret: 'callback' }, handler,
    );
    await gateway.sendSessionCreate('oc_1');
    const listener = mocks.listeners.get('cardAction');
    await listener?.({
      messageId: 'om_form', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: {
        value: undefined, tag: 'button', name: 'session_create_submit',
        formValue: { session_name: 'restore', session_agent: 'codex', session_cwd: '/work', session_resume: 'picker' },
      },
    });
    await vi.waitFor(() => expect(rollback).toHaveBeenCalledWith(session));
    expect(mocks.send).toHaveBeenLastCalledWith('oc_1', expect.objectContaining({
      text: expect.stringContaining('新建 Session 表单打开失败'),
    }));
  });

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
        agentBinaries: { codex: 'codex', 'traex': 'traex', 'claude': 'claude' },
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
    await gateway.sendChoice('oc_1', '%1', screen, 'claude');
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
    const duplicate = await listener?.({
      messageId: 'om_form', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: {
        value: undefined, tag: 'button', name: 'choice_form_submit',
        formValue: { choice_selected_0: true, choice_selected_1: false, choice_selected_2: true },
      },
    });
    expect(duplicate).toEqual({ toast: { type: 'warning', content: '操作正在处理中，请稍候。' } });
    expect(mocks.updateCard).not.toHaveBeenCalled();
    finishAction?.({ type: 'refresh', content: '已选择', screen, paneId: '%1', agent: 'claude' });
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
        agentBinaries: { codex: 'codex', 'traex': 'traex', 'claude': 'claude' },
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
        agentBinaries: { codex: 'codex', 'traex': 'traex', 'claude': 'claude' },
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
        agentBinaries: { codex: 'codex', 'traex': 'traex', 'claude': 'claude' },
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
