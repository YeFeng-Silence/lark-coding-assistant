import { describe, expect, it } from 'vitest';
import { ActionSigner } from '../../src/lark/action-signing.js';
import { choiceCard, expiredActionCard, handledActionCard, interactionInputCard, manualControlCard, resumePickerCard, sessionCreateCard, sessionCreateFailureCard, sessionCreateOpenedCard, sessionCreateResultCard, sessionPickerCard, sessionStartupFailureCard, startupConflictCard, statusCard, stopCard } from '../../src/lark/cards.js';
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
    const card = interactionInputCard('claude', 'Chat about this') as Card;
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
    expect(card.header.title.content).toBe('assistant · codex 手动遥控');
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
    expect(card.header.title.content).toBe('codex 等待回答');
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
    const card = choiceCard('oc_1', '%3', screen, signer, 'claude') as InteractiveCard;
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
    const card = choiceCard('oc_1', '%4', screen, signer, 'traex') as InteractiveCard;
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
    expect(card.header).toMatchObject({ template: 'green', title: { content: 'assistant · codex' } });
    expect(card.body.elements[0]?.content).toContain('等待用户输入');
    expect(card.body.elements[1]?.columns?.map(({ elements }) => elements[0]?.content)).toEqual([
      '**Agent**\n🔵 codex', '**tmux**\n✅ 运行中',
    ]);
    expect(card.body.elements[2]?.columns?.[0]?.elements[0]?.content).toContain('/Users/feng/workspace/app');
    expect(card.body.elements[3]?.content).toContain('codex-cli 0\.147\.0');
    expect(card.body.elements[3]?.content).toContain('已绑定');
  });

  it('uses an orange status for a pending interaction and a grey empty state', () => {
    const session = {
      id: 'helix', agent: 'traex' as const, sessionName: 'lca-helix', paneId: '%2', cwd: '/work/helix',
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
    const card = choiceCard('oc_1', '%2', screen, signer, 'traex') as InteractiveCard;
    expect(card.header.title.content).toBe('traex 等待回答');
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
      kind: 'choice', interactionKind: 'question', agent: 'traex', action: '2', paneId: '%2', fingerprint: 'question-fp', chatId: 'oc_1',
    });
  });

  it('renders session choices with adjacent connect and stop actions', () => {
    const sessions = [
      { id: 'frontend', agent: 'codex' as const, sessionName: 'lca-frontend', paneId: '%1', cwd: '/work/front', agentVersion: '0.147', updatedAt: 1 },
      { id: 'backend', agent: 'traex' as const, sessionName: 'lca-backend', paneId: '%2', cwd: '/work/back', agentVersion: '0.201', updatedAt: 2 },
      { id: 'docs', agent: 'claude' as const, sessionName: 'lca-docs', paneId: '%3', cwd: '/work/docs', agentVersion: '2.1.235', updatedAt: 3 },
    ];
    const card = sessionPickerCard('oc_1', sessions, 'frontend', signer) as InteractiveCard;
    expect(card.body.elements.map((element) => element.tag)).toEqual([
      'markdown', 'column_set', 'hr', 'markdown', 'column_set', 'hr', 'markdown', 'column_set', 'hr', 'button',
    ]);
    expect(card.header.title.content).toBe('选择 Coding Session');
    expect(card.body.elements[0]?.content).toBe('🔵 **codex** · 1 个 session');
    expect(card.body.elements[3]?.content).toBe('🟣 **traex** · 1 个 session');
    expect(card.body.elements[6]?.content).toBe('🟠 **claude** · 1 个 session');
    const activeAccent = card.body.elements[1]?.columns?.[0];
    expect(activeAccent?.background_style).toBe('green');
    expect(activeAccent?.elements).toEqual([]);
    const activeColumn = card.body.elements[1]?.columns?.[1];
    expect(activeColumn?.background_style).toBe('grey');
    expect(activeColumn?.elements[0]?.content).toContain('● 当前连接');
    const activeButtons = activeColumn?.elements[1]?.columns?.map((column) => column.elements[0]);
    expect(activeButtons?.map((button) => button?.text?.content)).toEqual(['关闭']);
    expect(activeButtons?.[0]?.behaviors?.[0]?.value).toMatchObject({
      kind: 'session-stop', sessionId: 'frontend', action: 'request', paneId: '%1', fingerprint: '1',
    });
    const backendColumn = card.body.elements[4]?.columns?.[0];
    expect(backendColumn?.background_style).toBe('grey');
    expect(backendColumn?.elements[0]?.content).toContain('backend');
    const backendButtons = backendColumn?.elements[1]?.columns?.map((column) => column.elements[0]);
    expect(backendButtons?.map((button) => button?.text?.content)).toEqual(['连接 backend', '关闭']);
    expect(backendButtons?.[0]?.behaviors?.[0]?.value).toMatchObject({
      kind: 'session', agent: 'traex', action: 'backend', paneId: '%2', fingerprint: '2', chatId: 'oc_1',
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
      'markdown', 'column_set', 'column_set', 'column_set', 'hr', 'button',
    ]);
    expect(card.body.elements[2]?.columns?.[0]?.elements[0]?.content).toContain('two');
    expect(card.body.elements[2]?.columns?.[0]?.elements[1]?.columns?.[0]?.elements[0]?.text?.content).toBe('连接 two');
    expect(card.body.elements[3]?.columns?.[0]?.elements[0]?.content).toContain('three');
    expect(card.body.elements[3]?.columns?.[0]?.elements[1]?.columns?.[0]?.elements[0]?.text?.content).toBe('连接 three');
  });

  it('keeps session actions while disabling only the used new-session entry', () => {
    const session = {
      id: 'api', agent: 'codex' as const, sessionName: 'lca-api', paneId: '%3', cwd: '/work/api',
      agentVersion: '0.147', updatedAt: 3,
    };
    const card = sessionPickerCard('oc_1', [session], undefined, signer, undefined, false) as InteractiveCard;
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('选择 Coding Session');
    expect(serialized).toContain('连接 api');
    expect(serialized).toContain('关闭');
    expect(serialized).toContain('新建 Session 表单已发送');
    expect(serialized).not.toContain('＋ 新建 Session');
  });

  it('renders inline stop confirmation for only the target session', () => {
    const session = {
      id: 'api', agent: 'codex' as const, sessionName: 'lca-api', paneId: '%3', cwd: '/work/api',
      agentVersion: '0.147', updatedAt: 3,
    };
    const card = sessionPickerCard('oc_1', [session], 'api', signer, 'api') as InteractiveCard;
    const confirmation = card.body.elements[1]?.columns?.[1]?.elements[1];
    expect(confirmation?.tag).toBe('column_set');
    expect((confirmation?.columns?.[0] as unknown as { tag?: string })?.tag).toBe('column');
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('确认关闭');
    expect(serialized).toContain('取消');
    expect(serialized).toContain('session-stop');
    expect(serialized).not.toContain('连接 api');
  });

  it('renders a signed native Resume Picker card', () => {
    const session = {
      id: 'restore', agent: 'traex' as const, sessionName: 'lca-restore', paneId: '%8', cwd: '/work',
      agentVersion: '0.201', updatedAt: 8,
    };
    const card = resumePickerCard('oc_1', session, {
      agent: 'traex', fingerprint: 'picker-fp', selectedIndex: 0, position: 1, total: 3,
      canPrevious: false, canNext: true,
      options: [
        { id: 'one', label: '北京天气', detail: '5dago', selected: true, visibleIndex: 0 },
        { id: 'two', label: '现在时间', detail: '5dago', selected: false, visibleIndex: 1 },
      ],
    }, signer) as InteractiveCard;
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('北京天气');
    expect(serialized).toContain('当前 1/3');
    expect(serialized).toContain('下一页');
    expect(serialized).toContain('resume-picker');
    expect(serialized).toContain('select:two');
    expect(card.body.elements[1]?.tag).toBe('column_set');
    expect((card.body.elements[1]?.columns?.[0] as unknown as { tag?: string })?.tag).toBe('column');
  });

  it('renders actionable startup conflict recovery', () => {
    const owner = {
      id: 'assistant', agent: 'codex' as const, sessionName: 'lca-assistant', paneId: '%1', cwd: '/work',
      agentVersion: '0.148', updatedAt: 10,
    };
    const card = startupConflictCard('oc_1', { id: 'restore', agent: 'codex', cwd: '/work' }, owner, signer) as InteractiveCard;
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('连接 assistant');
    expect(serialized).toContain('启动新会话');
    expect(serialized).toContain('startup-conflict');
    expect(serialized).toContain('"action":"new"');
  });

  it('renders a signed new-session entry and one complete creation form', () => {
    const picker = sessionPickerCard('oc_1', [], undefined, signer) as InteractiveCard;
    const createButton = picker.body.elements.at(-1);
    expect(createButton?.text?.content).toBe('＋ 新建 Session');
    expect(createButton?.behaviors?.[0]?.value).toMatchObject({ kind: 'session-create', action: 'open', chatId: 'oc_1' });

    const formCard = sessionCreateCard() as InteractiveCard;
    const serialized = JSON.stringify(formCard);
    expect(serialized).toContain('session_name');
    expect(serialized).toContain('session_agent');
    expect(serialized).toContain('session_cwd');
    expect(serialized).toContain('session_resume');
    expect(serialized).not.toContain('session_resume_id');
    expect(serialized).not.toContain('恢复指定历史 ID');
    expect(serialized).not.toContain('恢复上次会话');
    expect(serialized).toContain('session_create_submit');
    expect(serialized).toContain('codex');
    expect(serialized).toContain('traex');
    expect(serialized).toContain('claude');
    const form = formCard.body.elements.find(({ tag }) => tag === 'form');
    const selects = form?.elements?.filter(({ tag }) => tag === 'select_static') ?? [];
    expect(selects).toHaveLength(2);
    expect(selects.every((select) => select.label === undefined)).toBe(true);
    expect(selects[0]?.options?.map(({ text }) => text.content)).toEqual(['codex', 'traex', 'claude']);
    expect(selects[1]?.options?.map(({ value }) => value)).toEqual(['new', 'picker']);
  });

  it('renders project selection, manual fallback, and session fields in one form', () => {
    const formCard = sessionCreateCard({
      mode: 'projects', snapshotId: 'snapshot-1', page: 1, pageCount: 3, partial: true,
      warnings: ['one root failed'],
      candidates: [{
        cwd: '/Users/feng/workspace/api', label: 'api · ~/workspace', source: 'configured', git: true,
      }],
      draft: {
        sessionId: 'backend', agent: 'traex', resumeMode: 'picker',
        cwd: '/Users/feng/workspace/api', projectCwd: '/Users/feng/workspace/api',
      },
    }) as InteractiveCard;
    const serialized = JSON.stringify(formCard);
    expect(serialized).toContain('api · ~/workspace');
    expect(serialized).toContain('/Users/feng/workspace/api');
    expect(serialized).toContain('手动填写其他路径');
    expect(serialized).toContain('__manual__');
    expect(serialized).toContain('其他路径（可选）');
    expect(serialized).not.toContain('select-directory');
    expect(serialized).not.toContain('上一页');
    expect(serialized).not.toContain('下一页');
    expect(serialized).toContain('部分目录未加载');
    expect(serialized).toContain('session_name');
    expect(serialized).toContain('session_agent');
    expect(serialized).toContain('session_resume');
    expect(serialized).toContain('backend');
    expect(serialized).toContain('traex');
    expect(serialized).toContain('picker');
  });

  it('does not show pagination for a single project page', () => {
    const serialized = JSON.stringify(sessionCreateCard({
      mode: 'projects', snapshotId: 'snapshot-1', page: 0, pageCount: 1, partial: false, warnings: [],
      candidates: [{ cwd: '/work/api', label: 'api · /work', source: 'active', git: true }],
      draft: { agent: 'codex', resumeMode: 'new' },
    }));
    expect(serialized).not.toContain('上一页');
    expect(serialized).not.toContain('下一页');
  });

  it('renders an actionable manual-path hint when no projects are available', () => {
    const serialized = JSON.stringify(sessionCreateCard({
      mode: 'manual', page: 0, pageCount: 1, candidates: [], hasProjectCandidates: false,
      partial: false, warnings: ['尚未发现可选项目；请手动填写路径，或在本机运行 lca workspace add ~/workspace。'],
      draft: { agent: 'claude', resumeMode: 'new' },
    }));
    expect(serialized).toContain('lca workspace add ~/workspace');
    expect(serialized).toContain('~/workspace/project');
    expect(serialized).not.toContain('返回项目列表');
  });

  it('uses CardKit 2 default values when redisplaying session inputs', () => {
    const serialized = JSON.stringify(sessionCreateCard({
      mode: 'manual', page: 0, pageCount: 1, candidates: [], partial: false, warnings: [],
      draft: {
        sessionId: 'docs', agent: 'claude', resumeMode: 'picker',
        cwd: '/work/docs', manualCwd: '/work/docs',
      },
    }));
    expect(serialized).toContain('"default_value":"docs"');
    expect(serialized).toContain('"default_value":"/work/docs"');
    expect(serialized).not.toContain('initial_value');
  });

  it('renders a button-free audit card after opening a new-session form', () => {
    const serialized = JSON.stringify(sessionCreateOpenedCard());
    expect(serialized).toContain('新建表单已打开');
    expect(serialized).toContain('/sessions');
    expect(serialized).not.toContain('button');
  });

  it('renders a column-free startup failure card with raw terminal output', () => {
    const card = sessionStartupFailureCard('oc_1', {
      sessionId: 'test5', agent: 'codex', exitStatus: 1,
      terminalExcerpt: 'Error: thread already has an active writer',
    }, signer) as InteractiveCard;
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('Error: thread already has an active writer');
    expect(serialized).toContain('新建 Session');
    expect(serialized).toContain('查看 Sessions');
    expect(serialized).toContain('session-start-error');
    expect(serialized).not.toContain('column');
  });

  it('renders an actionable timeout card with absolute cwd and cleanup result', () => {
    const card = sessionStartupFailureCard('oc_1', {
      sessionId: 'helix', agent: 'traex', reason: 'timeout', cwd: '/Users/feng/workspace/helix',
      stage: 'agent-version', elapsedMs: 30_012, terminalExcerpt: 'checking for updates…',
    }, signer) as InteractiveCard;
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('/Users/feng/workspace/helix');
    expect(serialized).toContain('启动超过 30 秒，已取消并清理');
    expect(serialized).toContain('agent-version');
    expect(serialized).toContain('checking for updates');
    expect(serialized).toContain('新建 Session');
    expect(serialized).toContain('查看 Sessions');
  });

  it('renders recovery actions for validation and other non-process startup failures', () => {
    const card = sessionCreateFailureCard('oc_1', '工作目录不可用。', signer) as InteractiveCard;
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('工作目录不可用');
    expect(serialized).toContain('新建 Session');
    expect(serialized).toContain('查看 Sessions');
    expect(serialized).toContain('session-start-error');
  });

  it('hides empty agent groups and renders a useful empty state', () => {
    const codexOnly = sessionPickerCard('oc_1', [{
      id: 'api', agent: 'codex', sessionName: 'lca-api', paneId: '%3', cwd: '/work/api',
      agentVersion: '0.147', updatedAt: 3,
    }], 'api', signer) as InteractiveCard;
    expect(codexOnly.body.elements[0]?.content).toContain('codex');
    expect(codexOnly.body.elements.some(({ content }) => content?.includes('traex'))).toBe(false);

    const empty = sessionPickerCard('oc_1', [], undefined, signer) as InteractiveCard;
    expect(empty.body.elements).toHaveLength(2);
    expect(empty.body.elements[0]?.content).toContain('暂无可连接');
  });

  it('shows absolute project paths in every session-related Lark card', () => {
    const cwd = '/Users/feng/a/very/long/company/workspace/project';
    const card = sessionPickerCard('oc_1', [{
      id: 'api', agent: 'codex', sessionName: 'lca-api', paneId: '%9', cwd,
      agentVersion: 'codex-cli 0.147.0', updatedAt: 9,
    }], 'api', signer) as InteractiveCard;
    const content = card.body.elements[1]?.columns?.[1]?.elements[0]?.content ?? '';
    expect(content).toContain(cwd);
    expect(content).not.toContain('~/');
    expect(content).not.toContain('…/');
    expect(content).not.toContain('0.147');

    const started = sessionCreateResultCard(true, '已启动。', {
      id: 'api', agent: 'codex', cwd,
    });
    const status = statusCard({
      state: { schemaVersion: 2, sessions: {}, updatedAt: 1 },
      session: { id: 'api', agent: 'codex', sessionName: 'lca-api', paneId: '%9', cwd, agentVersion: 'test', updatedAt: 9 },
      paneAlive: true,
    });
    const conflict = startupConflictCard('oc_1', { id: 'api-copy', agent: 'codex', cwd }, {
      id: 'api', agent: 'codex', sessionName: 'lca-api', paneId: '%9', cwd, agentVersion: 'test', updatedAt: 9,
    }, signer);
    for (const sessionCard of [started, status, conflict]) {
      expect(JSON.stringify(sessionCard)).toContain(cwd);
      expect(JSON.stringify(sessionCard)).not.toContain('~/');
      expect(JSON.stringify(sessionCard)).not.toContain('…/');
    }
  });

  it('renders a persistent audit card after an action succeeds', () => {
    const action = signer.sign({
      kind: 'session', agent: 'traex', action: 'backend', paneId: '%2', fingerprint: '2', chatId: 'oc_1',
    });
    const card = handledActionCard(action, '已连接到 backend', new Date('2026-08-13T13:05:06Z')) as ResultCard;
    expect(card.header).toMatchObject({ template: 'green', title: { content: 'traex session 已切换' } });
    expect(card.body.elements).toHaveLength(1);
    expect(card.body.elements[0]?.content).toContain('已连接到 backend');
    expect(card.body.elements[0]?.content).toContain('连接 backend');
    expect(card.body.elements[0]?.content).toContain('2026-08-13 21:05:06');
  });

  it('renders a persistent hint after a card or button expires', () => {
    const serialized = JSON.stringify(expiredActionCard());
    expect(serialized).toContain('卡片已失效');
    expect(serialized).toContain('/sessions');
    expect(serialized).not.toContain('button');
  });

  it('records the selected approval action', () => {
    const action = signer.sign({
      kind: 'choice', interactionKind: 'approval', agent: 'codex', action: '2', paneId: '%2', fingerprint: 'fp', chatId: 'oc_1',
    });
    const card = handledActionCard(action, '操作已发送给 codex。') as ResultCard;
    expect(card.header.title.content).toBe('codex 审批已处理');
    expect(card.body.elements[0]?.content).toContain('选择第 2 项');
  });

  it('records Trae CLI deny shortcut as rejected', () => {
    const action = signer.sign({
      kind: 'choice', interactionKind: 'approval', agent: 'traex', action: '5', paneId: '%2', fingerprint: 'fp', chatId: 'oc_1',
    });
    const card = handledActionCard(action, '操作已发送给 traex。') as ResultCard;
    expect(card.header.title.content).toBe('traex 审批已处理');
    expect(card.body.elements[0]?.content).toContain('选择第 5 项');
  });

  it('records a submitted Trae Question answer', () => {
    const action = signer.sign({
      kind: 'choice', interactionKind: 'question', agent: 'traex', action: '2', paneId: '%2', fingerprint: 'fp', chatId: 'oc_1',
    });
    const card = handledActionCard(action, '已向 traex 提交答案：No') as ResultCard;
    expect(card.header.title.content).toBe('traex 回答已提交');
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
      options?: Array<{ text: { content: string }; value: string }>;
      behaviors?: Array<{ value: object }>;
      form_action_type?: string;
      columns?: Array<{
        elements: Array<{
          tag: string;
          text?: { content: string };
          behaviors?: Array<{ value: object }>;
        }>;
      }>;
    }>;
    columns?: Array<{
      background_style: string;
      elements: Array<{
        tag: string;
        content?: string;
        text?: { content: string };
        behaviors?: Array<{ value: object }>;
        columns?: Array<{
          elements: Array<{
            tag: string;
            text?: { content: string };
            behaviors?: Array<{ value: object }>;
          }>;
        }>;
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
