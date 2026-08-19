import { homedir } from 'node:os';
import type { ScreenDetection } from '../screen/detector.js';
import type { ManagedSession } from '../core/model.js';
import type { ActionSigner } from './action-signing.js';
import type { SignedAction } from './action-signing.js';
import { getAgentAdapter, listAgentAdapters } from '../agents/registry.js';
import type { AgentId } from '../agents/types.js';
import type { RuntimeStatus } from '../daemon/protocol.js';

export function choiceCard(
  chatId: string,
  paneId: string,
  screen: ScreenDetection,
  signer: ActionSigner,
  agent: AgentId = 'codex',
): object {
  if (!screen.interaction) throw new Error('choice card requires a structured interaction');
  const interaction = screen.interaction;
  const buttons = screen.actions.map((action) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: choiceActionLabel(action.key, action.label, action.description) },
    type: choiceButtonType(action.risk, action.focused),
    width: 'fill',
    size: 'medium',
    behaviors: [{
      type: 'callback',
      value: signer.sign({
        kind: 'choice',
        interactionKind: interaction.kind,
        agent,
        action: action.key,
        paneId,
        fingerprint: interaction.revision ?? screen.fingerprint,
        chatId,
      }),
    }],
  }));
  const context = interaction.context.join('\n').slice(0, 1800);
  if (interaction.semantics?.activation === 'toggle') {
    const formElements = screen.actions.flatMap((action, index): Array<Record<string, unknown>> => {
      if (action.role === 'custom-input') {
        const selected = action.marker === 'checked' || action.marker === 'selected';
        return [
          {
            tag: 'checker',
            name: choiceFormFieldName(index),
            checked: selected,
            text: { tag: 'plain_text', content: `${action.key}. ${action.label}` },
          },
          {
            tag: 'input',
            name: inlineInputName(index),
            placeholder: { tag: 'plain_text', content: '请输入自定义内容' },
            input_type: 'multiline_text',
            rows: 2,
            auto_resize: true,
            max_rows: 4,
            max_length: 1000,
            width: 'fill',
            default_value: action.inputValue ?? '',
          },
        ];
      }
      if (action.role === 'submit') {
        return [{ tag: 'hr' }, {
          tag: 'button',
          name: choiceFormSubmitName(),
          text: { tag: 'plain_text', content: '提交答案' },
          type: 'primary',
          width: 'fill',
          size: 'medium',
          form_action_type: 'submit',
        }];
      }
      if (action.role !== 'answer') return [];
      const selected = action.marker === 'checked' || action.marker === 'selected';
      const details = action.description ? `\n${action.description}` : '';
      return [{
        tag: 'checker',
        name: choiceFormFieldName(index),
        checked: selected,
        text: { tag: 'plain_text', content: `${action.key}. ${action.label}${details}` },
      }];
    });
    if (!screen.actions.some(({ role }) => role === 'submit')) {
      formElements.push({ tag: 'hr' }, {
        tag: 'button',
        name: choiceFormSubmitName(),
        text: { tag: 'plain_text', content: '提交答案' },
        type: 'primary',
        width: 'fill',
        size: 'medium',
        form_action_type: 'submit',
      });
    }
    const immediateButtons = screen.actions
      .filter(({ role }) => role !== 'answer' && role !== 'custom-input' && role !== 'submit')
      .map((action) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: choiceActionLabel(action.key, action.label, action.description) },
        type: choiceButtonType(action.risk, action.focused),
        width: 'fill',
        size: 'medium',
        behaviors: [{
          type: 'callback',
          value: signer.sign({
            kind: 'choice', interactionKind: interaction.kind, agent, action: action.key, paneId,
            fingerprint: interaction.revision ?? screen.fingerprint, chatId,
          }),
        }],
      }));
    return cardElements(
      `${getAgentAdapter(agent).displayName} ${interactionTitle(interaction.kind)}`,
      [{ tag: 'markdown', content: `\`\`\`text\n${escapeFence(context || interaction.title)}\n\`\`\`` }, {
        tag: 'form',
        name: 'choice_form',
        direction: 'vertical',
        vertical_spacing: '8px',
        elements: formElements,
      }, ...immediateButtons],
    );
  }
  return card(
    `${getAgentAdapter(agent).displayName} ${interactionTitle(interaction.kind)}`,
    `\`\`\`text\n${escapeFence(context || '请选择一个选项')}\n\`\`\``,
    buttons,
  );
}

export const CHOICE_FORM_SUBMIT_ACTION = '__choice_form_submit__';

export function choiceFormSubmitName(): string {
  return 'choice_form_submit';
}

export function choiceFormFieldName(index: number): string {
  return `choice_selected_${index}`;
}

export function inlineInputName(index: number): string {
  return `custom_input_${index}`;
}

export function stopCard(
  chatId: string,
  paneId: string,
  fingerprint: string,
  signer: ActionSigner,
  agent: AgentId = 'codex',
): object {
  const agentName = getAgentAdapter(agent).displayName;
  return card(`确认停止 ${agentName}？`, `这会终止当前 ${agentName} 进程和受管 tmux 会话。`, [{
    tag: 'button',
    text: { tag: 'plain_text', content: '停止会话' },
    type: 'danger',
    behaviors: [{
      type: 'callback',
      value: signer.sign({ kind: 'stop', agent, action: 'confirm', paneId, fingerprint, chatId }, 2 * 60_000),
    }],
  }]);
}

export function interactionInputCard(agent: AgentId, label: string): object {
  return card(
    `${getAgentAdapter(agent).displayName} 等待补充内容`,
    `已进入 **${escapeMarkdown(label)}**。请直接发送补充说明。`,
    [],
    'orange',
  );
}

export type ManualControlState = 'active' | 'stale' | 'recovered' | 'exited' | 'error';

export interface ManualControlView {
  session: ManagedSession;
  screen: ScreenDetection;
  output: string;
  capturedAt: Date;
  state?: ManualControlState;
  notice?: string;
  lastOperation?: string;
  mode?: 'explicit' | 'fallback';
}

export const MANUAL_TEXT_FIELD = 'manual_text';
export const MANUAL_TYPE_ACTION = 'type';
export const MANUAL_SUBMIT_ACTION = 'submit';

export function manualControlCard(
  chatId: string,
  view: ManualControlView,
  signer: ActionSigner,
): object {
  const state = view.state ?? 'active';
  const mode = view.mode ?? 'fallback';
  const agentName = getAgentAdapter(view.session.agent).displayName;
  const fingerprint = view.screen.fingerprint;
  const sign = (action: string): SignedAction => signer.sign({
    kind: 'manual',
    sessionId: view.session.id,
    manualMode: mode,
    agent: view.session.agent,
    action,
    paneId: view.session.paneId,
    fingerprint,
    chatId,
  }, 10 * 60_000);
  const status = state === 'recovered'
    ? '✅ 已恢复结构化识别，请使用新发送的语义化操作卡。'
    : state === 'exited'
      ? '✅ 已退出手动遥控模式，本地 Agent 和 tmux 仍在运行。'
      : state === 'stale'
        ? '⚠️ 终端画面已变化，旧操作未执行；请确认最新画面后重试。'
        : state === 'error'
          ? `⚠️ ${escapeMarkdown(view.notice ?? '手动操作失败，请确认最新画面。')}`
          : mode === 'explicit'
            ? '⚠️ 已锁定手动遥控；即使恢复结构化识别，也会继续由你直接操作终端。'
            : '⚠️ 当前为手动遥控模式，所有操作都不会进行语义安全判断。';
  const metadata = [
    `**Session**  \`${escapeInlineCode(view.session.id)}\`  ·  **Agent**  ${escapeMarkdown(agentName)}`,
    `**状态**  \`${view.screen.state}\`  ·  **采集时间**  ${formatHandledAt(view.capturedAt)}`,
    view.lastOperation ? `**最近操作**  ${escapeMarkdown(view.lastOperation)}` : undefined,
    view.notice && state !== 'error' ? escapeMarkdown(view.notice) : undefined,
  ].filter(Boolean).join('\n');
  const elements: object[] = [
    { tag: 'markdown', content: status },
    { tag: 'markdown', content: metadata },
    { tag: 'markdown', content: `\`\`\`text\n${escapeFence(view.output).slice(-5000)}\n\`\`\`` },
  ];
  if (state === 'recovered' || state === 'exited') {
    return cardElements(`${view.session.id} · ${agentName} 手动遥控`, elements, state === 'recovered' ? 'green' : 'grey');
  }
  elements.push(
    manualButtonRow([
      manualButton('↖ 刷新', sign('refresh')),
      manualButton('↑', sign('up')),
      manualButton('Esc', sign('esc')),
    ]),
    manualButtonRow([
      manualButton('←', sign('left')),
      manualButton('Enter', sign('enter'), 'primary'),
      manualButton('→', sign('right')),
    ]),
    manualButtonRow([
      manualButton('Tab', sign('tab')),
      manualButton('↓', sign('down')),
      manualButton('Space', sign('space')),
    ]),
    {
      tag: 'form', name: 'manual_text_form', direction: 'vertical', vertical_spacing: '8px', elements: [
        {
          tag: 'input', name: MANUAL_TEXT_FIELD, input_type: 'multiline_text', rows: 2,
          auto_resize: true, max_rows: 4, max_length: 1000, width: 'fill',
          placeholder: { tag: 'plain_text', content: '输入要发送到当前终端的文本' },
        },
        manualFormButton('仅输入', MANUAL_TYPE_ACTION),
        manualFormButton('输入并提交', MANUAL_SUBMIT_ACTION, 'primary'),
      ],
    },
    manualButtonRow([
      manualButton('⌫ 退格', sign('backspace')),
      manualButton('Ctrl+C', sign('ctrl-c'), 'danger'),
      manualButton('结束遥控', sign('exit')),
    ]),
  );
  return cardElements(`${view.session.id} · ${agentName} 手动遥控`, elements, 'orange');
}

function manualButton(label: string, value: SignedAction, type = 'default'): object {
  return {
    tag: 'button', text: { tag: 'plain_text', content: label }, type, width: 'fill', size: 'medium',
    behaviors: [{ type: 'callback', value }],
  };
}

function manualFormButton(label: string, name: string, type = 'default'): object {
  return {
    tag: 'button', name, text: { tag: 'plain_text', content: label }, type, width: 'fill', size: 'medium',
    form_action_type: 'submit',
  };
}

function manualButtonRow(buttons: object[]): object {
  return {
    tag: 'column_set', flex_mode: 'none', horizontal_spacing: '6px',
    columns: buttons.map((button) => ({
      tag: 'column', width: 'weighted', weight: 1, elements: [button],
    })),
  };
}

export function statusCard(status: RuntimeStatus): object {
  const session = status.session;
  if (!session) {
    return {
      schema: '2.0',
      config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: 'Coding Assistant 状态' }, template: 'grey' },
      body: {
        padding: '12px',
        elements: [{
          tag: 'markdown',
          content: `⚪ **暂无 active session**\n\n当前共有 ${Object.keys(status.state.sessions ?? {}).length} 个可用 session，可发送 /sessions 进行选择。`,
        }],
      },
    };
  }

  const adapter = getAgentAdapter(session.agent);
  const visual = statusVisual(status);
  const path = formatDisplayPath(session.cwd);
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: `${session.id} · ${adapter.displayName}` }, template: visual.template },
    body: {
      vertical_spacing: '10px',
      padding: '12px',
      elements: [
        { tag: 'markdown', content: `<text_tag color='${visual.color}'>● ${visual.label}</text_tag>  **当前连接**` },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: '8px',
          columns: [
            statusColumn('Agent', `${agentMarker(session.agent)} ${adapter.displayName}`),
            statusColumn('tmux', status.paneAlive ? '✅ 运行中' : '⛔ 已停止'),
          ],
        },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: '0px',
          columns: [{
            tag: 'column',
            width: 'weighted',
            weight: 1,
            background_style: 'grey',
            padding: '9px 10px',
            elements: [{ tag: 'markdown', content: `**工作目录**\n\`${escapeInlineCode(path)}\`` }],
          }],
        },
        { tag: 'markdown', content: `**版本**  \`${escapeInlineCode(session.agentVersion)}\`\n**飞书连接**  ${status.state.boundChatId ? '已绑定' : '未绑定'}` },
      ],
    },
  };
}

export function sessionPickerCard(
  chatId: string,
  sessions: ManagedSession[],
  activeSessionId: string | undefined,
  signer: ActionSigner,
): object {
  const groups = listAgentAdapters()
    .map((adapter) => ({ adapter, sessions: sessions.filter((session) => session.agent === adapter.id) }))
    .filter(({ sessions: group }) => group.length > 0);
  const elements = groups.flatMap(({ adapter, sessions: group }, groupIndex) => [
    ...(groupIndex > 0 ? [{ tag: 'hr', margin: '6px 0px' }] : []),
    {
      tag: 'markdown',
      content: `${agentMarker(adapter.id)} **${adapter.displayName}** · ${group.length} 个 session`,
      text_size: 'heading',
      margin: '2px 0px 0px 0px',
    },
    ...group.map((session) => sessionCard(chatId, session, session.id === activeSessionId, signer)),
  ]);
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '选择 Coding Session' }, template: 'blue' },
    body: {
      vertical_spacing: '10px',
      padding: '12px',
      elements: elements.length > 0
        ? elements
        : [{ tag: 'markdown', content: '暂无可连接的 Coding Session。' }],
    },
  };
}

function sessionCard(
  chatId: string,
  session: ManagedSession,
  active: boolean,
  signer: ActionSigner,
): object {
  const content = [
    active
      ? `**${escapeMarkdown(session.id)}**  <text_tag color='green'>● 当前连接</text_tag>`
      : `**${escapeMarkdown(session.id)}**`,
    `📁 \`${escapeInlineCode(formatDisplayPath(session.cwd))}\``,
  ].join('\n\n');
  const elements: object[] = [{ tag: 'markdown', content }];
  if (!active) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `连接 ${session.id}` },
      type: 'primary',
      width: 'fill',
      size: 'medium',
      margin: '2px 0px 0px 0px',
      behaviors: [{
        type: 'callback',
        value: signer.sign({
          kind: 'session',
          agent: session.agent,
          action: session.id,
          paneId: session.paneId,
          fingerprint: String(session.updatedAt),
          chatId,
        }),
      }],
    });
  }
  const contentColumn = {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    vertical_spacing: '8px',
    background_style: 'grey',
    padding: '10px 12px',
    elements,
  };
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '0px',
    margin: '0px',
    columns: active
      ? [{
          tag: 'column',
          width: 'auto',
          background_style: 'green',
          padding: '0px 3px',
          elements: [],
        }, contentColumn]
      : [contentColumn],
  };
}

export function formatDisplayPath(path: string, home = homedir(), maxLength = 44): string {
  const display = path === home
    ? '~'
    : path.startsWith(`${home}/`)
      ? `~${path.slice(home.length)}`
      : path;
  if (display.length <= maxLength) return display;
  const segments = display.split('/').filter(Boolean);
  return segments.length <= 2 ? display : `…/${segments.slice(-2).join('/')}`;
}

function agentMarker(agent: AgentId): string {
  if (agent === 'codex') return '🔵';
  if (agent === 'trae-cli') return '🟣';
  return '🟠';
}

function statusColumn(title: string, value: string): object {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    background_style: 'grey',
    padding: '9px 10px',
    elements: [{ tag: 'markdown', content: `**${title}**\n${value}` }],
  };
}

function statusVisual(status: RuntimeStatus): { label: string; color: string; template: string } {
  if (!status.paneAlive || status.screen?.state === 'exited') return { label: '已停止', color: 'red', template: 'red' };
  if (status.screen?.state === 'failed') return { label: '执行失败', color: 'red', template: 'red' };
  if (status.screen?.interaction?.kind === 'approval') return { label: '等待审批', color: 'orange', template: 'orange' };
  if (status.screen?.interaction?.kind === 'question') return { label: '等待回答', color: 'orange', template: 'orange' };
  if (status.screen?.interaction?.kind === 'choice') return { label: '等待选择', color: 'orange', template: 'orange' };
  if (status.screen?.state === 'input') return { label: '等待输入', color: 'orange', template: 'orange' };
  if (status.screen?.state === 'running') return { label: '执行中', color: 'blue', template: 'blue' };
  if (status.screen?.state === 'starting') return { label: '启动中', color: 'blue', template: 'blue' };
  if (status.screen?.state === 'idle') return { label: '等待用户输入', color: 'green', template: 'green' };
  return { label: '状态未知', color: 'grey', template: 'grey' };
}

export function handledActionCard(
  action: SignedAction,
  result: string,
  handledAt = new Date(),
): object {
  const agentName = getAgentAdapter(action.agent).displayName;
  const title = action.kind === 'choice'
    ? `${agentName} ${handledInteractionTitle(action.interactionKind)}`
    : action.kind === 'session'
      ? `${agentName} session 已切换`
      : `${agentName} 会话已停止`;
  const actionLabel = action.kind === 'choice'
    ? `选择第 ${action.action} 项`
    : action.kind === 'session'
      ? `连接 ${action.action}`
      : '停止会话';
  const content = [
    `✅ ${escapeMarkdown(result)}`,
    '',
    `**操作**：${escapeMarkdown(actionLabel)}`,
    `**处理时间**：${formatHandledAt(handledAt)}`,
  ].join('\n');
  return card(title, content, [], 'green');
}

function card(title: string, content: string, buttons: object[], template = 'blue'): object {
  return cardElements(title, [{ tag: 'markdown', content }, ...buttons], template);
}

function cardElements(title: string, elements: object[], template = 'blue'): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { vertical_spacing: '8px', padding: '12px', elements },
  };
}

function interactionTitle(kind: 'approval' | 'question' | 'choice'): string {
  if (kind === 'approval') return '等待审批';
  if (kind === 'question') return '等待回答';
  return '等待选择';
}

function handledInteractionTitle(kind?: 'approval' | 'question' | 'choice'): string {
  if (kind === 'approval') return '审批已处理';
  if (kind === 'question') return '回答已提交';
  return '选择已提交';
}

function choiceButtonType(risk?: string, focused?: boolean): string {
  if (risk === 'persistent' || risk === 'privileged') return 'danger';
  if (risk === 'reject') return 'default';
  return focused ? 'primary' : 'default';
}

function choiceActionLabel(key: string, label: string, description?: string): string {
  const suffix = description ? ` · ${description}` : '';
  return `${key}. ${label}${suffix}`.slice(0, 80);
}

function toggleActionLabel(action: ScreenDetection['actions'][number]): string {
  if (action.role === 'submit') return '提交答案';
  if (action.role === 'custom-input') return '自定义输入';
  if (action.role === 'chat') return '继续对话';
  return action.marker === 'checked' || action.marker === 'selected' ? '取消选择' : '选择此项';
}

function escapeFence(value: string): string {
  return value.replace(/```/g, '``\\`');
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, '\\`');
}

function formatHandledAt(value: Date): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+.!|>-])/g, '\\$1');
}
