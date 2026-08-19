import { describe, expect, it } from 'vitest';
import { ActionSigner } from '../../src/lark/action-signing.js';
import { choiceCard, formatDisplayPath, handledActionCard, interactionInputCard, manualControlCard, sessionPickerCard, statusCard, stopCard } from '../../src/lark/cards.js';
import type { ScreenDetection } from '../../src/screen/detector.js';
import { detectClaudeScreen, detectCodexScreen, detectTraeScreen } from '../../src/screen/detector.js';

describe('CardKit 2 cards', () => {
  const signer = new ActionSigner('secret');

  it('places approval buttons directly in body.elements', () => {
    const screen: ScreenDetection = {
      state: 'approval', confidence: 0.9, normalized: '', fingerprint: 'fp',
      evidence: ['Would you like to run?'], hasDraftInput: false,
      interaction: { kind: 'approval', title: 'Would you like to run?', context: ['Would you like to run?'] },
      actions: [
        { id: 'option-1', label: 'Yes, proceed', key: '1', shortcut: 'y', focused: true, risk: 'normal' },
        { id: 'option-2', label: "Yes, don't ask again", key: '2', shortcut: 'p', risk: 'persistent', danger: true },
        { id: 'option-3', label: 'No', key: '3', shortcut: 'esc', risk: 'reject' },
      ],
    };
    const card = choiceCard('oc_1', '%1', screen, signer) as Card;
    expect(card.schema).toBe('2.0');
    expect(card.body.elements.map((element) => element.tag)).toEqual(['markdown', 'button', 'button', 'button']);
    expect(card.body.elements[0]?.content).toBe('```text\nWould you like to run?\n```');
    expect(card.body.elements.some((element) => element.tag === 'action')).toBe(false);
  });

  it('preserves approval context line breaks and removes duplicated terminal options', () => {
    const screen: ScreenDetection = {
      state: 'approval', confidence: 0.9, normalized: '', fingerprint: 'fp-context', hasDraftInput: false,
      evidence: [
        'Would you like to run the following command?',
        'Environment: local',
        'Reason: run checks before publishing',
        '$ npm test',
        '› 1. Yes, proceed (y)',
        "  2. Yes, and don't ask again (p)",
        '  3. No, and tell Codex what to do differently (esc)',
        'Press enter to confirm or esc to cancel',
      ],
      interaction: {
        kind: 'approval', title: 'Would you like to run the following command?',
        context: ['Would you like to run the following command?', 'Environment: local', 'Reason: run checks before publishing', '$ npm test'],
      },
      actions: [
        { id: 'option-1', label: 'Yes, proceed', key: '1', shortcut: 'y', focused: true, risk: 'normal' },
        { id: 'option-2', label: "Yes, and don't ask again", key: '2', shortcut: 'p', risk: 'persistent', danger: true },
        { id: 'option-3', label: 'No', key: '3', shortcut: 'esc', risk: 'reject' },
      ],
    };
    const card = choiceCard('oc_1', '%1', screen, signer) as ApprovalCard;
    expect(card.body.elements[0]?.content).toBe([
      '```text',
      'Would you like to run the following command?',
      'Environment: local',
      'Reason: run checks before publishing',
      '$ npm test',
      '```',
    ].join('\n'));
    expect(card.body.elements.slice(1).map(({ text }) => text?.content)).toEqual([
      '1. Yes, proceed', "2. Yes, and don't ask again", '3. No',
    ]);
  });

  it('places the stop button directly in body.elements', () => {
    const card = stopCard('oc_1', '%1', 'fp', signer) as Card;
    expect(card.body.elements.map((element) => element.tag)).toEqual(['markdown', 'button']);
  });

  it('asks for interaction notes without exposing bridge command-routing details', () => {
    const card = interactionInputCard('claude-code', 'Chat about this') as Card;
    expect(card.body.elements[0]?.content).toBe('已进入 **Chat about this**。请直接发送补充说明。');
  });

  it('renders a signed single-card manual terminal remote', () => {
    const session = {
      id: 'assistant', agent: 'codex' as const, sessionName: 'lca-assistant', paneId: '%9',
      cwd: '/tmp', agentVersion: '0.148.0', updatedAt: 1,
    };
    const screen: ScreenDetection = {
      state: 'unknown', confidence: 0.4, normalized: 'Unrecognized prompt\n❯', fingerprint: 'manual-fp',
      evidence: [], actions: [], hasDraftInput: false,
    };
    const card = manualControlCard('oc_1', {
      session, screen, output: 'Unrecognized prompt\n❯', capturedAt: new Date('2026-08-19T10:00:00Z'),
    }, signer) as InteractiveCard;
    const serialized = JSON.stringify(card);
    expect(card.header.title.content).toBe('assistant · Codex 手动遥控');
    expect(serialized).toContain('手动遥控模式');
    expect(serialized).toContain('Ctrl+C');
    expect(serialized).toContain('⌫ 退格');
    expect(serialized).toContain('输入并提交');
    expect(serialized).toContain('manual_text');
    expect(serialized).toContain('"max_length":1000');
    expect(serialized).toContain('manual-fp');
    expect(serialized).toContain('"kind":"manual"');
  });

  it('renders a real Codex request_user_input screen as a single-choice card', () => {
    const screen = detectCodexScreen(`Question 1/1 (1 unanswered)
请选择验证环境
› 1. 测试环境 (Recommended)  用于回归验证。
  2. 生产环境                用于正式发布。
  3. None of the above       Optionally, add details in notes (tab).
tab to add notes | enter to submit answer | esc to interrupt`);
    const card = choiceCard('oc_1', '%5', screen, signer, 'codex') as InteractiveCard;
    expect(card.header.title.content).toBe('Codex 等待回答');
    expect(card.body.elements.slice(1).map(({ text }) => text?.content)).toEqual([
      '1. 测试环境 (Recommended) · 用于回归验证。',
      '2. 生产环境 · 用于正式发布。',
      '3. None of the above · Optionally, add details in notes (tab).',
    ]);
  });

  it('renders checkbox answers and submit as a structured multi-select card', () => {
    const screen = detectClaudeScreen(`☐ Permissions
Which tools should be allowed?
❯ 1. [ ] Read tools
  Read files only.
  2. [x] Edit tools
  Modify files.
  3. [ ] Type done
     Submit
Enter to select · ↑/↓ to navigate · Esc to cancel`);
    const card = choiceCard('oc_1', '%3', screen, signer, 'claude-code') as InteractiveCard;
    const form = card.body.elements.find(({ tag }) => tag === 'form');
    const checkers = form?.elements?.filter(({ tag }) => tag === 'checker') ?? [];
    const buttons = form?.elements?.filter(({ tag }) => tag === 'button') ?? [];
    const input = form?.elements?.find(({ tag }) => tag === 'input');
    expect(card.body.elements.map(({ tag }) => tag)).toEqual(['markdown', 'form']);
    expect(checkers.map(({ name, checked, text }) => ({ name, checked, text: text?.content }))).toEqual([
      { name: 'choice_selected_0', checked: false, text: '1. Read tools\nRead files only.' },
      { name: 'choice_selected_1', checked: true, text: '2. Edit tools\nModify files.' },
      { name: 'choice_selected_2', checked: false, text: '3. Type something' },
    ]);
    expect(checkers.every((checker) => !checker.behaviors)).toBe(true);
    expect(input).toMatchObject({
      name: 'custom_input_2', default_value: 'done', input_type: 'multiline_text',
      placeholder: { content: '请输入自定义内容' },
    });
    expect(input).not.toHaveProperty('label');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({
      name: 'choice_form_submit', width: 'fill', form_action_type: 'submit', text: { content: '提交答案' },
    });
  });

  it('renders Trae key-committed multi-select as the same transactional form', () => {
    const screen = detectTraeScreen(`Question 1/1 (1 unanswered)
请选择测试项
❯ [ ] 1. 代码检查  进行代码静态检查
  [x] 2. 执行测试  运行单元测试
  [ ] 3. Other     Optionally, add details in notes (tab).
space to toggle | tab to add notes | enter to submit answer
esc to interrupt`);
    const card = choiceCard('oc_1', '%4', screen, signer, 'trae-cli') as InteractiveCard;
    const form = card.body.elements.find(({ tag }) => tag === 'form');
    expect(form?.elements?.filter(({ tag }) => tag === 'checker')).toHaveLength(3);
    expect(form?.elements?.find(({ tag }) => tag === 'input')).toMatchObject({ name: 'custom_input_2' });
    expect(form?.elements?.filter(({ tag }) => tag === 'button')).toEqual([
      expect.objectContaining({ name: 'choice_form_submit', form_action_type: 'submit' }),
    ]);
  });

  it('renders a clear green status card for an idle active session', () => {
    const session = {
      id: 'assistant', agent: 'codex' as const, sessionName: 'lca-assistant', paneId: '%1',
      cwd: '/Users/feng/workspace/app', agentVersion: 'codex-cli 0.147.0', updatedAt: 1,
    };
    const card = statusCard({
      state: { schemaVersion: 2, activeSessionId: 'assistant', boundChatId: 'oc_1', sessions: { assistant: session }, updatedAt: 1 },
      session,
      paneAlive: true,
      screen: {
        state: 'idle', confidence: 0.8, normalized: '', fingerprint: 'idle', evidence: [], actions: [], hasDraftInput: false,
      },
    }) as StatusCard;
    expect(card.header).toMatchObject({ template: 'green', title: { content: 'assistant · Codex' } });
    expect(card.body.elements[0]?.content).toContain('等待用户输入');
    expect(card.body.elements[1]?.columns?.map(({ elements }) => elements[0]?.content)).toEqual([
      '**Agent**\n🔵 Codex', '**tmux**\n✅ 运行中',
    ]);
    expect(card.body.elements[2]?.columns?.[0]?.elements[0]?.content).toContain('~/workspace/app');
    expect(card.body.elements[3]?.content).toContain('codex-cli 0\.147\.0');
    expect(card.body.elements[3]?.content).toContain('已绑定');
  });

  it('uses an orange status for a pending interaction and a grey empty state', () => {
    const session = {
      id: 'helix', agent: 'trae-cli' as const, sessionName: 'lca-helix', paneId: '%2', cwd: '/work/helix',
      agentVersion: 'traecli 0.201.2', updatedAt: 2,
    };
    const pending = statusCard({
      state: { schemaVersion: 2, activeSessionId: 'helix', sessions: { helix: session }, updatedAt: 2 },
      session,
      paneAlive: true,
      screen: {
        state: 'input', confidence: 0.92, normalized: '', fingerprint: 'q', evidence: [], hasDraftInput: false,
        interaction: { kind: 'question', title: 'Question 1/1', context: ['Question 1/1'] },
        actions: [{ id: 'option-1', key: '1', label: 'Yes', focused: true }],
      },
    }) as StatusCard;
    expect(pending.header.template).toBe('orange');
    expect(pending.body.elements[0]?.content).toContain('等待回答');

    const empty = statusCard({
      state: { schemaVersion: 2, sessions: {}, updatedAt: 3 }, paneAlive: false,
    }) as StatusCard;
    expect(empty.header.template).toBe('grey');
    expect(empty.body.elements[0]?.content).toContain('暂无 active session');
  });

  it('renders Trae Question choices as signed buttons', () => {
    const screen: ScreenDetection = {
      state: 'input', confidence: 0.92, normalized: '', fingerprint: 'question-fp', hasDraftInput: false,
      evidence: [
        'Question 1/1 (1 unanswered)',
        'Do you want me to proceed?',
        '❯ 1. Yes  Proceed with implementation',
        '  2. No   Provide more details',
        'tab to add notes | enter to submit answer | esc to interrupt',
      ],
      interaction: {
        kind: 'question', title: 'Question 1/1 (1 unanswered)',
        context: ['Question 1/1 (1 unanswered)', 'Do you want me to proceed?'],
      },
      actions: [
        { id: 'answer-1', label: 'Yes', key: '1', description: 'Proceed with implementation', focused: true },
        { id: 'answer-2', label: 'No', key: '2', description: 'Provide more details', focused: false },
      ],
    };
    const card = choiceCard('oc_1', '%2', screen, signer, 'trae-cli') as InteractiveCard;
    expect(card.header.title.content).toBe('Trae CLI 等待回答');
    expect(card.body.elements[0]?.content).toBe([
      '```text',
      'Question 1/1 (1 unanswered)',
      'Do you want me to proceed?',
      '```',
    ].join('\n'));
    expect(card.body.elements.slice(1).map(({ text }) => text?.content)).toEqual([
      '1. Yes · Proceed with implementation',
      '2. No · Provide more details',
    ]);
    expect(card.body.elements[2]?.behaviors?.[0]?.value).toMatchObject({
      kind: 'choice', interactionKind: 'question', agent: 'trae-cli', action: '2', paneId: '%2', fingerprint: 'question-fp', chatId: 'oc_1',
    });
  });

  it('renders session choices and omits a button for the active session', () => {
    const sessions = [
      { id: 'frontend', agent: 'codex' as const, sessionName: 'lca-frontend', paneId: '%1', cwd: '/work/front', agentVersion: '0.147', updatedAt: 1 },
      { id: 'backend', agent: 'trae-cli' as const, sessionName: 'lca-backend', paneId: '%2', cwd: '/work/back', agentVersion: '0.201', updatedAt: 2 },
      { id: 'docs', agent: 'claude-code' as const, sessionName: 'lca-docs', paneId: '%3', cwd: '/work/docs', agentVersion: '2.1.235', updatedAt: 3 },
    ];
    const card = sessionPickerCard('oc_1', sessions, 'frontend', signer) as InteractiveCard;
    expect(card.body.elements.map((element) => element.tag)).toEqual([
      'markdown', 'column_set', 'hr', 'markdown', 'column_set', 'hr', 'markdown', 'column_set',
    ]);
    expect(card.header.title.content).toBe('选择 Coding Session');
    expect(card.body.elements[0]?.content).toBe('🔵 **Codex** · 1 个 session');
    expect(card.body.elements[3]?.content).toBe('🟣 **Trae CLI** · 1 个 session');
    expect(card.body.elements[6]?.content).toBe('🟠 **Claude Code** · 1 个 session');
    const activeAccent = card.body.elements[1]?.columns?.[0];
    expect(activeAccent?.background_style).toBe('green');
    expect(activeAccent?.elements).toEqual([]);
    const activeColumn = card.body.elements[1]?.columns?.[1];
    expect(activeColumn?.background_style).toBe('grey');
    expect(activeColumn?.elements[0]?.content).toContain('● 当前连接');
    expect(activeColumn?.elements.some(({ tag }) => tag === 'button')).toBe(false);
    const backendColumn = card.body.elements[4]?.columns?.[0];
    expect(backendColumn?.background_style).toBe('grey');
    expect(backendColumn?.elements[0]?.content).toContain('backend');
    expect(backendColumn?.elements[1]?.text?.content).toBe('连接 backend');
    expect(backendColumn?.elements[1]?.behaviors?.[0]?.value).toMatchObject({
      kind: 'session', agent: 'trae-cli', action: 'backend', paneId: '%2', fingerprint: '2', chatId: 'oc_1',
    });
  });

  it('places each connection button directly after its session description', () => {
    const sessions = [
      { id: 'one', agent: 'codex' as const, sessionName: 'lca-one', paneId: '%1', cwd: '/one', agentVersion: '0.147', updatedAt: 1 },
      { id: 'two', agent: 'codex' as const, sessionName: 'lca-two', paneId: '%2', cwd: '/two', agentVersion: '0.147', updatedAt: 2 },
      { id: 'three', agent: 'codex' as const, sessionName: 'lca-three', paneId: '%3', cwd: '/three', agentVersion: '0.147', updatedAt: 3 },
    ];
    const card = sessionPickerCard('oc_1', sessions, 'one', signer) as InteractiveCard;
    expect(card.body.elements.map((element) => element.tag)).toEqual([
      'markdown', 'column_set', 'column_set', 'column_set',
    ]);
    expect(card.body.elements[2]?.columns?.[0]?.elements[0]?.content).toContain('two');
    expect(card.body.elements[2]?.columns?.[0]?.elements[1]?.text?.content).toBe('连接 two');
    expect(card.body.elements[3]?.columns?.[0]?.elements[0]?.content).toContain('three');
    expect(card.body.elements[3]?.columns?.[0]?.elements[1]?.text?.content).toBe('连接 three');
  });

  it('hides empty agent groups and renders a useful empty state', () => {
    const codexOnly = sessionPickerCard('oc_1', [{
      id: 'api', agent: 'codex', sessionName: 'lca-api', paneId: '%3', cwd: '/work/api',
      agentVersion: '0.147', updatedAt: 3,
    }], 'api', signer) as InteractiveCard;
    expect(codexOnly.body.elements[0]?.content).toContain('Codex');
    expect(codexOnly.body.elements.some(({ content }) => content?.includes('Trae CLI'))).toBe(false);

    const empty = sessionPickerCard('oc_1', [], undefined, signer) as InteractiveCard;
    expect(empty.body.elements).toHaveLength(1);
    expect(empty.body.elements[0]?.content).toContain('暂无可连接');
  });

  it('shortens home and long paths without showing agent versions', () => {
    expect(formatDisplayPath('/Users/feng/workspace/api', '/Users/feng')).toBe('~/workspace/api');
    expect(formatDisplayPath('/Users/feng', '/Users/feng')).toBe('~');
    expect(formatDisplayPath('/opt/work/api', '/Users/feng')).toBe('/opt/work/api');
    expect(formatDisplayPath('/Users/feng/a/very/long/company/workspace/project', '/Users/feng', 24))
      .toBe('…/workspace/project');

    const card = sessionPickerCard('oc_1', [{
      id: 'api', agent: 'codex', sessionName: 'lca-api', paneId: '%9', cwd: '/Users/feng/workspace/api',
      agentVersion: 'codex-cli 0.147.0', updatedAt: 9,
    }], 'api', signer) as InteractiveCard;
    const content = card.body.elements[1]?.columns?.[1]?.elements[0]?.content ?? '';
    expect(content).toContain('~/workspace/api');
    expect(content).not.toContain('0.147');
  });

  it('renders a persistent audit card after an action succeeds', () => {
    const action = signer.sign({
      kind: 'session', agent: 'trae-cli', action: 'backend', paneId: '%2', fingerprint: '2', chatId: 'oc_1',
    });
    const card = handledActionCard(action, '已连接到 backend', new Date('2026-08-13T13:05:06Z')) as ResultCard;
    expect(card.header).toMatchObject({ template: 'green', title: { content: 'Trae CLI session 已切换' } });
    expect(card.body.elements).toHaveLength(1);
    expect(card.body.elements[0]?.content).toContain('已连接到 backend');
    expect(card.body.elements[0]?.content).toContain('连接 backend');
    expect(card.body.elements[0]?.content).toContain('2026-08-13 21:05:06');
  });

  it('records the selected approval action', () => {
    const action = signer.sign({
      kind: 'choice', interactionKind: 'approval', agent: 'codex', action: '2', paneId: '%2', fingerprint: 'fp', chatId: 'oc_1',
    });
    const card = handledActionCard(action, '操作已发送给 Codex。') as ResultCard;
    expect(card.header.title.content).toBe('Codex 审批已处理');
    expect(card.body.elements[0]?.content).toContain('选择第 2 项');
  });

  it('records Trae CLI deny shortcut as rejected', () => {
    const action = signer.sign({
      kind: 'choice', interactionKind: 'approval', agent: 'trae-cli', action: '5', paneId: '%2', fingerprint: 'fp', chatId: 'oc_1',
    });
    const card = handledActionCard(action, '操作已发送给 Trae CLI。') as ResultCard;
    expect(card.header.title.content).toBe('Trae CLI 审批已处理');
    expect(card.body.elements[0]?.content).toContain('选择第 5 项');
  });

  it('records a submitted Trae Question answer', () => {
    const action = signer.sign({
      kind: 'choice', interactionKind: 'question', agent: 'trae-cli', action: '2', paneId: '%2', fingerprint: 'fp', chatId: 'oc_1',
    });
    const card = handledActionCard(action, '已向 Trae CLI 提交答案：No') as ResultCard;
    expect(card.header.title.content).toBe('Trae CLI 回答已提交');
    expect(card.body.elements[0]?.content).toContain('选择第 2 项');
  });
});

interface Card {
  schema: string;
  body: { elements: Array<{ tag: string; content?: string }> };
}

interface InteractiveCard {
  header: { title: { content: string } };
  body: { elements: Array<{
    tag: string;
    width?: string;
    content?: string;
    text?: { content: string };
    behaviors?: Array<{ value: object }>;
    default_value?: string;
    input_type?: string;
    name?: string;
    form_action_type?: string;
    elements?: Array<{
      tag: string;
      width?: string;
      content?: string;
      text?: { content: string };
      label?: { content: string };
      placeholder?: { content: string };
      default_value?: string;
      input_type?: string;
      name?: string;
      checked?: boolean;
      behaviors?: Array<{ value: object }>;
      form_action_type?: string;
    }>;
    columns?: Array<{
      background_style: string;
      elements: Array<{
        tag: string;
        content?: string;
        text?: { content: string };
        behaviors?: Array<{ value: object }>;
      }>;
    }>;
  }> };
}

interface ApprovalCard {
  body: { elements: Array<{
    content?: string;
    text?: { content: string };
  }> };
}

interface ResultCard {
  header: { template: string; title: { content: string } };
  body: { elements: Array<{ content?: string }> };
}

interface StatusCard {
  header: { template: string; title: { content: string } };
  body: { elements: Array<{
    content?: string;
    columns?: Array<{ elements: Array<{ content?: string }> }>;
  }> };
}
