import type { ScreenDetection } from '../screen/detector.js';
import type { ManagedSession } from '../core/model.js';
import type { SessionCreateView } from '../workspace/session-create.js';
import { emptySessionCreateDraft } from '../workspace/session-create.js';
import type { ActionSigner } from './action-signing.js';
import type { SignedAction } from './action-signing.js';
import { getAgentAdapter, listAgentAdapters } from '../agents/registry.js';
import type { AgentId } from '../agents/types.js';
import type { ResumePickerView } from '../screen/resume-picker.js';
import type { RuntimeStatus } from '../daemon/protocol.js';
import type { SessionStartupFailure } from '../session/startup-failure.js';

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
  const path = session.cwd;
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
  confirmingStopSessionId?: string,
  allowCreate = true,
): object {
  const groups = listAgentAdapters()
    .map((adapter) => ({ adapter, sessions: sessions.filter((session) => session.agent === adapter.id) }))
    .filter(({ sessions: group }) => group.length > 0);
  const elements: object[] = groups.flatMap(({ adapter, sessions: group }, groupIndex) => [
    ...(groupIndex > 0 ? [{ tag: 'hr', margin: '6px 0px' }] : []),
    {
      tag: 'markdown',
      content: `${agentMarker(adapter.id)} **${adapter.displayName}** · ${group.length} 个 session`,
      text_size: 'heading',
      margin: '2px 0px 0px 0px',
    },
    ...group.map((session) => sessionCard(
      chatId,
      session,
      session.id === activeSessionId,
      signer,
      confirmingStopSessionId === session.id,
    )),
  ]);
  if (elements.length > 0) elements.push({ tag: 'hr', margin: '8px 0px' });
  else elements.push({ tag: 'markdown', content: '暂无可连接的 Coding Session，可以直接新建一个。' });
  elements.push(allowCreate
    ? {
        tag: 'button',
        text: { tag: 'plain_text', content: '＋ 新建 Session' },
        type: 'primary',
        width: 'fill',
        size: 'medium',
        behaviors: [{
          type: 'callback',
          value: signer.sign({
            kind: 'session-create', agent: 'codex', action: 'open', paneId: '', fingerprint: 'create', chatId,
          }, 10 * 60_000),
        }],
      }
    : {
        tag: 'markdown',
        content: '✅ 新建 Session 表单已发送；仍可查看或操作上方 Session。',
      });
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '选择 Coding Session' }, template: 'blue' },
    body: {
      vertical_spacing: '10px',
      padding: '12px',
      elements,
    },
  };
}

export const SESSION_CREATE_SUBMIT_ACTION = 'session_create_submit';
export const SESSION_CREATE_NAME_FIELD = 'session_name';
export const SESSION_CREATE_AGENT_FIELD = 'session_agent';
export const SESSION_CREATE_CWD_FIELD = 'session_cwd';
export const SESSION_CREATE_PROJECT_FIELD = 'session_project';
export const SESSION_CREATE_RESUME_FIELD = 'session_resume';
export const SESSION_CREATE_MANUAL_VALUE = '__manual__';

export function sessionCreateCard(view: SessionCreateView = {
  mode: 'manual', page: 0, pageCount: 1, candidates: [], partial: false, warnings: [], draft: emptySessionCreateDraft(),
}): object {
  const directoryElements = view.mode === 'projects'
    ? projectDirectoryFields(view)
    : [{
      tag: 'input', name: SESSION_CREATE_CWD_FIELD,
      default_value: view.draft.manualCwd,
      placeholder: { tag: 'plain_text', content: '~/workspace/project 或 /absolute/path' },
      label: { tag: 'plain_text', content: '项目目录' },
    }];
  const noticeLines = [
    ...view.warnings.map((warning) => `⚠️ ${escapeMarkdown(warning)}`),
    ...(view.partial ? ['⚠️ 部分目录未加载；可选择已显示项目或手动填写路径。'] : []),
  ];
  const notices = noticeLines.length > 0
    ? [{ tag: 'markdown', content: noticeLines.join('\n') }]
    : [];
  return cardElements('新建 Coding Session', [
    { tag: 'markdown', content: '在本机受管 tmux 中启动一个新会话；创建成功后会自动连接。' },
    ...notices,
    {
      tag: 'form', name: 'session_create_form', direction: 'vertical', vertical_spacing: '10px', elements: [
        {
          tag: 'input', name: SESSION_CREATE_NAME_FIELD, required: true,
          default_value: view.draft.sessionId,
          placeholder: { tag: 'plain_text', content: 'Session 名称，例如 helix' },
          label: { tag: 'plain_text', content: 'Session 名称' },
        },
        {
          tag: 'select_static', name: SESSION_CREATE_AGENT_FIELD, required: true,
          placeholder: { tag: 'plain_text', content: '选择 Agent' },
          initial_option: view.draft.agent,
          options: listAgentAdapters().map((adapter) => ({
            text: { tag: 'plain_text', content: adapter.displayName }, value: adapter.id,
          })),
        },
        ...directoryElements,
        {
          tag: 'select_static', name: SESSION_CREATE_RESUME_FIELD,
          placeholder: { tag: 'plain_text', content: '选择启动方式' },
          initial_option: view.draft.resumeMode,
          options: [
            { text: { tag: 'plain_text', content: '新会话' }, value: 'new' },
            { text: { tag: 'plain_text', content: '打开原生 Resume Picker' }, value: 'picker' },
          ],
        },
        {
          tag: 'button', name: SESSION_CREATE_SUBMIT_ACTION,
          text: { tag: 'plain_text', content: '启动并连接' }, type: 'primary', width: 'fill', size: 'medium',
          form_action_type: 'submit',
        },
      ],
    },
  ]);
}

function projectDirectoryFields(view: SessionCreateView): object[] {
  const options = [...view.candidates.map((candidate) => ({
    text: { tag: 'plain_text', content: candidate.label }, value: candidate.cwd,
  })), { text: { tag: 'plain_text', content: '手动填写其他路径…' }, value: SESSION_CREATE_MANUAL_VALUE }];
  return [{
    tag: 'select_static', name: SESSION_CREATE_PROJECT_FIELD,
    placeholder: { tag: 'plain_text', content: '选择项目目录' },
    initial_option: view.draft.projectCwd,
    required: true,
    options,
  }, {
    tag: 'input', name: SESSION_CREATE_CWD_FIELD,
    default_value: view.draft.manualCwd,
    placeholder: { tag: 'plain_text', content: '选择“手动填写其他路径…”时填写' },
    label: { tag: 'plain_text', content: '其他路径（可选）' },
  }];
}

export function sessionCreateResultCard(
  success: boolean,
  content: string,
  session?: Pick<ManagedSession, 'id' | 'agent' | 'cwd'>,
): object {
  const details = session
    ? `\n\n**Session**  \`${escapeInlineCode(session.id)}\`\n**Agent**  ${escapeMarkdown(getAgentAdapter(session.agent).displayName)}\n**工作目录**  \`${escapeInlineCode(session.cwd)}\``
    : '';
  return cardElements(
    success ? 'Session 已启动' : 'Session 启动失败',
    [{ tag: 'markdown', content: `${success ? '✅' : '⚠️'} ${escapeMarkdown(content)}${details}` }],
    success ? 'green' : 'red',
  );
}

export function sessionCreateProgressCard(): object {
  return cardElements('正在启动 Session', [
    { tag: 'markdown', content: '⏳ 正在创建 tmux pane，并确认 Agent 和原生 Session 状态…' },
  ], 'blue');
}

export function sessionCreateOpenedCard(): object {
  return cardElements('新建表单已打开', [{
    tag: 'markdown',
    content: '✅ 请在最新发送的“新建 Coding Session”卡片中继续操作。\n\n如需查看 Session，请发送 `/sessions`。',
  }], 'grey');
}

export function sessionCreateFailureCard(chatId: string, content: string, signer: ActionSigner): object {
  return cardElements('Session 启动失败', [
    { tag: 'markdown', content: `⚠️ ${escapeMarkdown(content)}` },
    ...sessionFailureActions(chatId, '', 'codex', signer),
  ], 'red');
}

export function sessionStartupFailureCard(
  chatId: string,
  failure: SessionStartupFailure,
  signer: ActionSigner,
): object {
  if (failure.reason === 'timeout') {
    const details = [
      `⚠️ **Session**  \`${escapeInlineCode(failure.sessionId)}\``,
      `**Agent**  ${escapeMarkdown(getAgentAdapter(failure.agent).displayName)}`,
      `**工作目录**  \`${escapeInlineCode(failure.cwd ?? '未知')}\``,
      `**结果**  启动超过 30 秒，已取消并清理`,
      `**超时阶段**  \`${escapeInlineCode(failure.stage ?? 'unknown')}\``,
    ].join('\n');
    const output = failure.terminalExcerpt.trim()
      ? [{ tag: 'markdown', content: `**最近终端输出**\n\n\`\`\`text\n${escapeFence(failure.terminalExcerpt)}\n\`\`\`` }]
      : [];
    return cardElements('Session 启动失败', [
      { tag: 'markdown', content: details },
      ...output,
      ...sessionFailureActions(chatId, failure.sessionId, failure.agent, signer),
    ], 'red');
  }
  const exitStatus = failure.exitStatus === undefined ? '未知' : String(failure.exitStatus);
  return cardElements('Session 启动失败', [
    {
      tag: 'markdown',
      content: `⚠️ **Session**  \`${escapeInlineCode(failure.sessionId)}\`\n**Agent**  ${escapeMarkdown(getAgentAdapter(failure.agent).displayName)}\n**退出码**  \`${exitStatus}\``,
    },
    { tag: 'markdown', content: `**原始错误**\n\n\`\`\`text\n${escapeFence(failure.terminalExcerpt)}\n\`\`\`` },
    ...sessionFailureActions(chatId, failure.sessionId, failure.agent, signer),
  ], 'red');
}

function sessionFailureActions(chatId: string, sessionId: string, agent: AgentId, signer: ActionSigner): object[] {
  const common = {
    kind: 'session-start-error' as const,
    sessionId,
    agent,
    paneId: '',
    fingerprint: 'startup-error',
    chatId,
  };
  return [
    actionButton('新建 Session', 'primary', signer.sign({ ...common, action: 'create' }, 10 * 60_000)),
    actionButton('查看 Sessions', 'default', signer.sign({ ...common, action: 'sessions' }, 10 * 60_000)),
  ];
}

function sessionCard(
  chatId: string,
  session: ManagedSession,
  active: boolean,
  signer: ActionSigner,
  confirmingStop = false,
): object {
  const content = [
    active
      ? `**${escapeMarkdown(session.id)}**  <text_tag color='green'>● 当前连接</text_tag>`
      : `**${escapeMarkdown(session.id)}**`,
    `📁 \`${escapeInlineCode(session.cwd)}\``,
  ].join('\n\n');
  const elements: object[] = [{ tag: 'markdown', content }];
  elements.push(confirmingStop
    ? sessionStopConfirmation(chatId, session, signer)
    : sessionActions(chatId, session, active, signer));
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

function sessionActions(chatId: string, session: ManagedSession, active: boolean, signer: ActionSigner): object {
  const buttons: object[] = [];
  if (!active) buttons.push(actionButton(`连接 ${session.id}`, 'primary', signer.sign({
    kind: 'session', agent: session.agent, action: session.id, paneId: session.paneId,
    fingerprint: String(session.updatedAt), chatId,
  })));
  buttons.push(actionButton('关闭', 'danger', signer.sign({
    kind: 'session-stop', sessionId: session.id, agent: session.agent, action: 'request', paneId: session.paneId,
    fingerprint: String(session.updatedAt), chatId,
  })));
  return buttonRow(buttons);
}

function sessionStopConfirmation(chatId: string, session: ManagedSession, signer: ActionSigner): object {
  const common = {
    kind: 'session-stop' as const, sessionId: session.id, agent: session.agent, paneId: session.paneId,
    fingerprint: String(session.updatedAt), chatId,
  };
  return {
    tag: 'column_set', flex_mode: 'none', columns: [{
      tag: 'column', width: 'weighted', weight: 1, background_style: 'grey', padding: '8px 10px',
      vertical_spacing: '6px',
      elements: [
        { tag: 'markdown', content: `⚠️ 确认关闭 **${escapeMarkdown(session.id)}**？Agent 和 tmux session 将退出。` },
        buttonRow([
          actionButton('确认关闭', 'danger', signer.sign({ ...common, action: 'confirm' })),
          actionButton('取消', 'default', signer.sign({ ...common, action: 'cancel' })),
        ]),
      ],
    }],
  };
}

export function resumePickerCard(
  chatId: string,
  session: ManagedSession,
  picker: ResumePickerView,
  signer: ActionSigner,
): object {
  const common = {
    kind: 'resume-picker' as const, sessionId: session.id, agent: session.agent, paneId: session.paneId,
    fingerprint: picker.fingerprint, chatId,
  };
  const optionElements = picker.options.map((option) => ({
    tag: 'column_set', flex_mode: 'none', columns: [{
      tag: 'column', width: 'weighted', weight: 1, background_style: 'grey',
      padding: '9px 10px', vertical_spacing: '5px',
      elements: [
        { tag: 'markdown', content: `${option.selected ? '●' : '○'} **${escapeMarkdown(option.label)}**${option.detail ? `\n${escapeMarkdown(option.detail)}` : ''}` },
        actionButton('恢复此 Session', option.selected ? 'primary' : 'default', signer.sign({ ...common, action: `select:${option.id}` }, 10 * 60_000)),
      ],
    }],
  }));
  const navigation = [
    ...(picker.canPrevious ? [actionButton('上一页', 'default', signer.sign({ ...common, action: 'previous' }, 10 * 60_000))] : []),
    actionButton('刷新', 'default', signer.sign({ ...common, action: 'refresh' }, 10 * 60_000)),
    ...(picker.canNext ? [actionButton('下一页', 'default', signer.sign({ ...common, action: 'next' }, 10 * 60_000))] : []),
    actionButton('取消', 'danger', signer.sign({ ...common, action: 'cancel' }, 10 * 60_000)),
  ];
  return cardElements(
    '选择要恢复的 Session',
    [
      { tag: 'markdown', content: `**${escapeMarkdown(session.id)} · ${escapeMarkdown(getAgentAdapter(session.agent).displayName)}**${picker.position && picker.total ? `  ·  当前 ${picker.position}/${picker.total}` : ''}` },
      ...optionElements,
      buttonRow(navigation),
    ],
    'yellow',
  );
}

export function startupConflictCard(
  chatId: string,
  requested: Pick<ManagedSession, 'id' | 'agent' | 'cwd'>,
  owner: ManagedSession,
  signer: ActionSigner,
): object {
  const common = {
    kind: 'startup-conflict' as const,
    sessionId: requested.id,
    agent: requested.agent,
    paneId: owner.paneId,
    fingerprint: String(owner.updatedAt),
    chatId,
  };
  return cardElements('Session 已由其他连接占用', [
    {
      tag: 'markdown',
      content: `要恢复的 **${escapeMarkdown(requested.agent)}** 原生 Session 已由 LCA Session **${escapeMarkdown(owner.id)}** 连接。\n\n**请求名称**  \`${escapeInlineCode(requested.id)}\`\n**工作目录**  \`${escapeInlineCode(requested.cwd)}\``,
    },
    buttonRow([
      actionButton(`连接 ${owner.id}`, 'primary', signer.sign({ ...common, action: 'connect' }, 10 * 60_000)),
      actionButton('启动新会话', 'default', signer.sign({ ...common, action: 'new' }, 10 * 60_000)),
      actionButton('取消', 'danger', signer.sign({ ...common, action: 'cancel' }, 10 * 60_000)),
    ]),
  ], 'yellow');
}

function actionButton(text: string, type: string, value: SignedAction): object {
  return {
    tag: 'button', text: { tag: 'plain_text', content: text }, type, size: 'medium',
    behaviors: [{ type: 'callback', value }],
  };
}

function buttonRow(buttons: object[]): object {
  return {
    tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', margin: '2px 0px 0px 0px',
    columns: buttons.map((button) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [button] })),
  };
}

function agentMarker(agent: AgentId): string {
  if (agent === 'codex') return '🔵';
  if (agent === 'traex') return '🟣';
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

export function expiredActionCard(): object {
  return cardElements('卡片已失效', [{
    tag: 'markdown',
    content: '⚠️ 此卡片或按钮已过期、已处理，或 bridge daemon 已重启。\n\n请重新发送对应命令获取最新卡片；Session 相关操作可发送 `/sessions`。',
  }], 'grey');
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
