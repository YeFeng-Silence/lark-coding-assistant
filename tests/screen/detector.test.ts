import { describe, expect, it } from 'vitest';
import { detectClaudeScreen, detectCodexScreen, detectTraeScreen } from '../../src/screen/detector.js';
import { normalizeScreen } from '../../src/screen/normalize.js';

describe('Codex screen detection', () => {
  it('normalizes ANSI output', () => {
    expect(normalizeScreen('\u001b[31mhello\u001b[0m\r\n\n\nworld  ')).toBe('hello\n\nworld');
  });

  it('normalizes non-breaking, full-width, and tab spacing', () => {
    expect(normalizeScreen('A\u00a0B\u3000C\tD  ')).toBe('A B C  D');
  });

  it('recognizes a structured approval and exposes only mapped actions', () => {
    const screen = detectCodexScreen(`Would you like to run the following command?\n\n$ echo hello\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again (p)\n  3. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel`);
    expect(screen.state).toBe('approval');
    expect(screen.confidence).toBeGreaterThanOrEqual(0.9);
    expect(screen.interaction?.kind).toBe('approval');
    expect(screen.actions.map((action) => action.key)).toEqual(['1', '2', '3']);
    expect(screen.actions.map((action) => action.shortcut)).toEqual(['y', 'p', 'esc']);
    expect(screen.actions.find((action) => action.shortcut === 'p')).toMatchObject({
      label: "Yes, and don't ask again",
      risk: 'persistent',
      danger: true,
    });
  });

  it('does not approve from a single vague keyword', () => {
    const screen = detectCodexScreen('Approval required somewhere');
    expect(screen.state).not.toBe('approval');
    expect(screen.actions).toEqual([]);
  });

  it('recognizes the 0.147 permissions approval shortcuts', () => {
    const screen = detectCodexScreen(`Would you like to grant these permissions?\n› 1. Yes, grant these permissions for this turn (y)\n  4. No, continue without permissions (d)\nPress enter to confirm or esc to cancel`);
    expect(screen.state).toBe('approval');
    expect(screen.actions.map((action) => action.shortcut)).toEqual(['y', 'd']);
  });

  it('recognizes a real Codex 0.148 request_user_input single-choice screen', () => {
    const screen = detectCodexScreen(`Question 1/1 (1 unanswered)
请选择验证环境

› 1. 测试环境 (Recommended)  用于回归验证。
  2. 生产环境                用于正式发布。
  3. None of the above       Optionally, add details in notes (tab).

tab to add notes | enter to submit answer | esc to interrupt`);

    expect(screen).toMatchObject({ state: 'input', confidence: 0.92 });
    expect(screen.interaction).toMatchObject({
      kind: 'question', title: '请选择验证环境',
      semantics: { cardinality: 'one', activation: 'submit', commit: { mode: 'immediate' } },
    });
    expect(screen.actions).toMatchObject([
      { key: '1', label: '测试环境 (Recommended)', description: '用于回归验证。', focused: true, role: 'answer' },
      { key: '2', label: '生产环境', description: '用于正式发布。', focused: false, role: 'answer' },
      {
        key: '3', label: 'None of the above', description: 'Optionally, add details in notes (tab).',
        focused: false, role: 'custom-input', editor: { openKey: 'Tab', submitKey: 'Enter', commitsInteraction: true },
      },
    ]);
  });

  it('recognizes a wrapped persistent command-prefix option', () => {
    const screen = detectCodexScreen(`Would you like to run the following command?
$ git add -A && FILES=$(git diff --cached --name-only)
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`git add -A && FILES=$(git diff
     --cached --name-only)\` (p)
  3. No, and tell Codex what to do differently (esc)
Press enter to confirm or esc to cancel`);
    expect(screen.actions.map((action) => action.shortcut)).toEqual(['y', 'p', 'esc']);
  });

  it('maps every wrapped approval option to one matching action', () => {
    const screen = detectCodexScreen(`Would you like to run the following command?
$ git add -A && git commit -m test
› 1. Yes, proceed (y)
  2. Yes, always allow commands that start with
     git add -A (a)
  3. Yes, and don't ask again for commands that start with
     git add -A && git commit (p)
  4. No, and tell Codex what to do differently (esc)
Press enter to confirm or esc to cancel`);
    expect(screen.actions).toMatchObject([
      { label: 'Yes, proceed', key: '1', shortcut: 'y', risk: 'normal' },
      { label: 'Yes, always allow commands that start with git add -A', key: '2', shortcut: 'a', risk: 'persistent' },
      { label: 'Yes, and don\'t ask again for commands that start with git add -A && git commit', key: '3', shortcut: 'p', risk: 'persistent' },
      { label: 'No, and tell Codex what to do differently', key: '4', shortcut: 'esc', risk: 'reject' },
    ]);
  });

  it('keeps approval fingerprints stable when unrelated scrollback changes', () => {
    const modal = `Would you like to run the following command?\n$ echo hello\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\nPress enter to confirm or esc to cancel`;
    expect(detectCodexScreen(`old spinner 1\n${modal}`).fingerprint)
      .toBe(detectCodexScreen(`old spinner 2\n${modal}`).fingerprint);
  });

  it('detects a local draft at the input prompt', () => {
    const screen = detectCodexScreen('OpenAI Codex\n› unfinished local text');
    expect(screen.state).toBe('idle');
    expect(screen.hasDraftInput).toBe(true);
  });

  it('does not treat a dim Codex recommendation as local draft input', () => {
    const screen = detectCodexScreen('OpenAI Codex\n\u001b[1m›\u001b[0m \u001b[2mExplain this codebase\u001b[0m');
    expect(screen.state).toBe('idle');
    expect(screen.hasDraftInput).toBe(false);
  });

  it('treats any fully dim composer text as a placeholder without matching its wording', () => {
    const screen = detectCodexScreen('OpenAI Codex\n\u001b[1m›\u001b[0m \u001b[2mA future dynamic recommendation\u001b[0m');
    expect(screen.hasDraftInput).toBe(false);
  });

  it('still treats the same visible text as a draft when it is not dim', () => {
    const screen = detectCodexScreen('OpenAI Codex\n› Explain this codebase');
    expect(screen.hasDraftInput).toBe(true);
  });

  it('treats non-dim ghost text as a placeholder when the terminal cursor stays at the prompt start', () => {
    const screen = detectClaudeScreen('Claude Code\n❯ 用样式 3 演示一次计划审批界面', true, { x: 2, y: 1 });
    expect(screen.state).toBe('idle');
    expect(screen.hasDraftInput).toBe(false);
  });

  it('keeps non-dim composer text as a real draft when the cursor moved into the content', () => {
    const screen = detectClaudeScreen('Claude Code\n❯ actual user input', true, { x: 19, y: 1 });
    expect(screen.hasDraftInput).toBe(true);
  });

  it('treats partially non-dim composer text as a real draft', () => {
    const screen = detectCodexScreen('OpenAI Codex\n\u001b[1m›\u001b[0m \u001b[2mSuggested prefix \u001b[22muser text');
    expect(screen.hasDraftInput).toBe(true);
  });

  it('does not stay running because completed scrollback contains the word running', () => {
    const screen = detectCodexScreen(`The previous task mentioned a running process.\n${Array.from({ length: 20 }, (_, index) => `result ${index}`).join('\n')}\n› \u001b[2mA suggestion\u001b[0m`);
    expect(screen.state).toBe('idle');
  });

  it('keeps running when an active spinner coexists with the bottom composer', () => {
    const screen = detectCodexScreen(`◦ Working (4s • esc to interrupt)\n› Ask Codex to do anything`);
    expect(screen.state).toBe('running');
  });

  it('does not accept input while the model is still loading', () => {
    const screen = detectCodexScreen(`OpenAI Codex\nmodel: loading /model to change\n› Ask Codex to do anything`);
    expect(screen.state).toBe('running');
  });

  it('does not treat a stale approval in scrollback as an active approval', () => {
    const screen = detectCodexScreen(`Would you like to run the following command?\n› 1. Yes, proceed (y)\n2. No (esc)\n${Array.from({ length: 20 }, (_, index) => `result ${index}`).join('\n')}\n› \u001b[2mA suggestion\u001b[0m`);
    expect(screen.state).toBe('idle');
  });
});

describe('Trae CLI screen detection', () => {
  it('recognizes the Trae composer and ignores a dim placeholder', () => {
    const screen = detectTraeScreen('TraeCode CLI (v0.201.1)\n\u001b[1m❯\u001b[0m \u001b[2mRun /review on my current changes\u001b[0m');
    expect(screen.state).toBe('idle');
    expect(screen.hasDraftInput).toBe(false);
  });

  it('recognizes a visible Trae draft', () => {
    const screen = detectTraeScreen('TraeCode CLI (v0.201.1)\n❯ unfinished local text');
    expect(screen.state).toBe('idle');
    expect(screen.hasDraftInput).toBe(true);
  });

  it('dynamically exposes every real Trae approval choice', () => {
    const screen = detectTraeScreen(`Would you like to run the following command?
$ ruby -e "puts :approval_probe"
❯ 1. Yes, proceed (y)
  2. Yes, switch this session to auto mode (r)
  3. Yes, switch this session to full access mode (f)
  4. Yes, and don't ask again for commands that start with ruby (p)
  5. No, and tell TraeCode CLI what to do differently (esc)
Press enter to confirm or esc to cancel`);
    expect(screen.state).toBe('approval');
    expect(screen.actions.map(({ key }) => key)).toEqual(['1', '2', '3', '4', '5']);
    expect(screen.actions.map(({ shortcut }) => shortcut)).toEqual(['y', 'r', 'f', 'p', 'esc']);
    expect(screen.actions.map(({ risk }) => risk)).toEqual(['normal', 'persistent', 'privileged', 'persistent', 'reject']);
  });

  it('recognizes a Trae Question and exposes its answer choices', () => {
    const raw = `TraeCode CLI (v0.201.2)
◆ Working

Question 1/1 (1 unanswered)
I have read the relevant SKILL.md and script. Do you want me to proceed with creating the implementation plan?

❯ 1. Yes                Proceed with implementation
  2. No                 Provide more details
  3. None of the above  Optionally, add details in notes (tab).

tab to add notes | enter to submit answer | esc to interrupt`;
    const screen = detectTraeScreen(raw);
    expect(screen.state).toBe('input');
    expect(screen.confidence).toBeGreaterThanOrEqual(0.9);
    expect(screen.actions).toMatchObject([
      { key: '1', label: 'Yes', description: 'Proceed with implementation', focused: true },
      { key: '2', label: 'No', description: 'Provide more details', focused: false },
      { key: '3', label: 'None of the above', description: 'Optionally, add details in notes (tab).', focused: false },
    ]);
  });

  it('recognizes Trae checkbox multi-select semantics without agent-specific execution rules', () => {
    const screen = detectTraeScreen(`TraeCode CLI (v0.201.4)

Question 1/1 (1 unanswered)
请选择测试项

  [ ] 1. 代码检查  进行代码静态检查
❯ [x] 2. 执行测试  运行单元测试和集成测试
  [ ] 3. 查看日志  查看系统和应用日志
  [ ] 4. 生成报告  生成测试和检查报告
  [ ] 5. Other     Optionally, add details in notes (tab).

space to toggle | tab to add notes | enter to submit answer
esc to interrupt`);
    expect(screen.state).toBe('input');
    expect(screen.actions).toMatchObject([
      { key: '1', label: '代码检查', marker: 'unchecked', role: 'answer', focused: false },
      { key: '2', label: '执行测试', marker: 'checked', role: 'answer', focused: true },
      { key: '3', label: '查看日志', marker: 'unchecked', role: 'answer' },
      { key: '4', label: '生成报告', marker: 'unchecked', role: 'answer' },
      {
        key: '5', label: 'Other', marker: 'unchecked', role: 'custom-input',
        editor: { openKey: 'Tab', submitKey: 'Enter', commitsInteraction: true },
      },
    ]);
    expect(screen.interaction?.semantics).toMatchObject({
      cardinality: 'many', activation: 'toggle', toggleKey: 'Space', commit: { mode: 'key', key: 'Enter' },
    });
  });

  it('keeps a Trae Question fingerprint stable when local selection moves', () => {
    const question = (markerOne: string, markerTwo: string) => `Question 1/1 (1 unanswered)
Proceed?
${markerOne} 1. Yes  Continue
${markerTwo} 2. No   Stop
tab to add notes | enter to submit answer | esc to interrupt`;
    const first = detectTraeScreen(question('❯', ' '));
    const second = detectTraeScreen(question(' ', '❯'));
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.interaction?.revision).toBe(second.interaction?.revision);
    expect(first.actions.find(({ focused }) => focused)?.key).toBe('1');
    expect(second.actions.find(({ focused }) => focused)?.key).toBe('2');
  });

  it('recognizes an agent-neutral numbered choice without fixed shortcuts', () => {
    const screen = detectTraeScreen(`Select a deployment target
❯ 1. Staging       Deploy for verification
  2. Production    Deploy to users
Enter to select or esc to cancel`);
    expect(screen.state).toBe('input');
    expect(screen.interaction?.kind).toBe('choice');
    expect(screen.actions).toMatchObject([
      { key: '1', label: 'Staging', description: 'Deploy for verification', focused: true },
      { key: '2', label: 'Production', description: 'Deploy to users', focused: false },
    ]);
  });

  it('does not treat numbered prose without an active submit footer as a choice', () => {
    const screen = detectTraeScreen(`TraeCode CLI
1. Inspect the repository
2. Update the implementation
3. Run tests
◆ Working`);
    expect(screen.interaction).toBeUndefined();
    expect(screen.actions).toEqual([]);
  });

  it('keeps running when the Trae spinner coexists with its placeholder composer', () => {
    const screen = detectTraeScreen(`◆ Working… (7s • esc to interrupt)\n❯ Write tests for @filename`);
    expect(screen.state).toBe('running');
  });
});

describe('Claude Code screen detection', () => {
  it('separates a side preview and unnumbered controls from answer labels', () => {
    const screen = detectClaudeScreen(`────────────────────────────────────────
 ☐ Preview choice

Which interface should be shown? (preview is on the right)

❯ 1. Current interface       ┌────────────────┐
  2. Permission dialog       │ [Preview]      │
  3. Plan approval           │ some drawing   │
  4. Stop                    └────────────────┘

                              Notes: press n to add
                                     notes
────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel`);

    expect(screen.interaction?.title).toBe('Which interface should be shown? (preview is on the right)');
    expect(screen.actions).toMatchObject([
      { key: '1', label: 'Current interface', role: 'answer' },
      { key: '2', label: 'Permission dialog', role: 'answer' },
      { key: '3', label: 'Plan approval', role: 'answer' },
      { key: '4', label: 'Stop', role: 'answer' },
      { key: 'custom-input', label: 'Add notes', role: 'custom-input', shortcut: 'n' },
      { key: 'chat', label: 'Chat about this', role: 'chat' },
    ]);
    expect(screen.actions.slice(0, 4).every(({ description }) => description === undefined)).toBe(true);
  });

  it('isolates and classifies a checkbox question with an explicit submit control', () => {
    const screen = detectClaudeScreen(`⏺ User declined to answer questions
  ⎿  · Previous question and answer

✻ Crunched for 45s

❯ Ask another permission question
────────────────────────────────────────
←  ☐ Tool permissions  ✔ Submit  →

Which tools should be authorized by default?

❯ 1. [ ] Read-only tools
  Read, Glob, and Grep without modifying files.
  2. [ ] File editing
  Write and Edit can modify the workspace.
  3. [ ] Network access
  WebSearch and WebFetch can call external services.
  4. [ ] Subagents and orchestration
  Agent and Workflow use additional tokens.
  5. [ ] Type something
     Submit
────────────────────────────────────────
  6. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`);

    expect(screen.interaction).toMatchObject({
      kind: 'question',
      title: 'Which tools should be authorized by default?',
      semantics: {
        cardinality: 'many', activation: 'toggle', commit: { mode: 'explicit', controlId: 'submit' },
      },
    });
    expect(screen.interaction?.context.join('\n')).not.toContain('Previous question');
    expect(screen.actions).toMatchObject([
      { key: '1', label: 'Read-only tools', description: 'Read, Glob, and Grep without modifying files.', marker: 'unchecked', role: 'answer' },
      { key: '2', label: 'File editing', description: 'Write and Edit can modify the workspace.', marker: 'unchecked', role: 'answer' },
      { key: '3', label: 'Network access', description: 'WebSearch and WebFetch can call external services.', marker: 'unchecked', role: 'answer' },
      { key: '4', label: 'Subagents and orchestration', description: 'Agent and Workflow use additional tokens.', marker: 'unchecked', role: 'answer' },
      { key: '5', label: 'Type something', marker: 'unchecked', role: 'custom-input' },
      { key: 'submit', label: 'Submit', role: 'submit' },
      { key: '6', label: 'Chat about this', role: 'chat' },
    ]);
  });

  it('separates cursor focus from checked state in the live Claude multi-select variant', () => {
    const screen = detectClaudeScreen(`────────────────────────────────────────
←  ☐ 工具授权  ✔ Submit  →

请选择需要授权的工具

❯ 1. [✔] 只读工具
  Read / Glob / Grep，不修改任何内容。
  2. [ ] 写入工具
  Write / Edit，会修改工作区内容。
  3. [ ] Type done
     Submit
────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`);

    expect(screen.interaction).toMatchObject({
      title: '请选择需要授权的工具',
      semantics: { cardinality: 'many', activation: 'toggle', commit: { mode: 'explicit', controlId: 'submit' } },
    });
    expect(screen.actions).toMatchObject([
      { key: '1', label: '只读工具', marker: 'checked', focused: true, role: 'answer' },
      { key: '2', label: '写入工具', marker: 'unchecked', focused: false, role: 'answer' },
      { key: '3', label: 'Type something', inputValue: 'done', marker: 'unchecked', role: 'custom-input' },
      { key: 'submit', role: 'submit' },
      { key: '4', role: 'chat' },
    ]);
  });

  it('keeps a localized replacement value classified as the inline custom input', () => {
    const screen = detectClaudeScreen(`────────────────────────────────────────
←  ☒ 工具授权  ✔ Submit  →
请选择需要授权的工具
  1. [✔] 只读工具
  Read / Glob / Grep，不修改任何内容。
  2. [ ] 写入工具
  Write / Edit，会修改工作区内容。
❯ 3. [✔] 最终补充
     Submit
Enter to select · ↑/↓ to navigate · Esc to cancel`);

    expect(screen.actions).toMatchObject([
      { key: '1', role: 'answer' },
      { key: '2', role: 'answer' },
      { key: '3', label: 'Type something', inputValue: '最终补充', marker: 'checked', role: 'custom-input' },
      { key: 'submit', role: 'submit' },
    ]);
  });

  it('keeps one interaction identity while Claude checkbox state changes', () => {
    const question = (header: string, firstMarker: string) => `────────────────────────────────────────
←  ${header} 工具授权  ✔ Submit  →
请选择需要授权的工具
❯ 1. ${firstMarker} 只读工具
  2. [ ] 写入工具
  3. [ ] Type something
     Submit
Enter to select · ↑/↓ to navigate · Esc to cancel`;
    const empty = detectClaudeScreen(question('☐', '[ ]'));
    const checked = detectClaudeScreen(question('☒', '[✔]'));

    expect(empty.interaction?.interactionId).toBe(checked.interaction?.interactionId);
    expect(empty.interaction?.revision).not.toBe(checked.interaction?.revision);
  });

  it('keeps one interaction identity when focus moves onto standalone Submit', () => {
    const question = (optionFocus: string, submitFocus: string) => `────────────────────────────────────────
←  ☒ 工具授权  ✔ Submit  →
请选择需要授权的工具
${optionFocus} 1. [✔] 只读工具
  2. [ ] Type done
${submitFocus}    Submit
────────────────────────────────────────
  3. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel`;
    const onOption = detectClaudeScreen(question('❯', ' '));
    const onSubmit = detectClaudeScreen(question(' ', '❯'));

    expect(onSubmit.actions.find(({ role }) => role === 'custom-input')?.description).toBeUndefined();
    expect(onOption.interaction?.interactionId).toBe(onSubmit.interaction?.interactionId);
    expect(onOption.interaction?.revision).toBe(onSubmit.interaction?.revision);
    expect(onSubmit.actions.find(({ role }) => role === 'submit')?.focused).toBe(true);
  });

  it('recognizes Claude review confirmation without a keyboard footer', () => {
    const screen = detectClaudeScreen(`────────────────────────────────────────
←  ☒ 工具授权  ✔ Submit  →

Review your answers

 ● 请选择需要授权的工具
   → 只读工具, 网络工具, done

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel`);

    expect(screen).toMatchObject({ state: 'input', confidence: 0.92 });
    expect(screen.interaction).toMatchObject({
      kind: 'question',
      title: 'Ready to submit your answers?',
      semantics: { cardinality: 'one', activation: 'submit', commit: { mode: 'immediate' } },
    });
    expect(screen.actions).toMatchObject([
      { key: '1', label: 'Submit answers', focused: true, role: 'answer', risk: 'normal' },
      { key: '2', label: 'Cancel', focused: false, role: 'answer', risk: 'reject' },
    ]);
    expect(screen.hasDraftInput).toBe(false);
  });

  it('recognizes an approval whose footer has no Enter instruction', () => {
    const screen = detectClaudeScreen(`Claude Code v2.1.235
Bash command
  touch /tmp/approval-probe
Do you want to proceed?
❯ 1. Yes
  2. Yes, and always allow access to touch commands
  3. No
Esc to cancel · Tab to amend · ctrl+e to explain`);
    expect(screen.state).toBe('approval');
    expect(screen.interaction?.kind).toBe('approval');
    expect(screen.actions).toMatchObject([
      { key: '1', label: 'Yes', focused: true, risk: 'normal' },
      { key: '2', label: 'Yes, and always allow access to touch commands', risk: 'persistent' },
      { key: '3', label: 'No', risk: 'reject' },
    ]);
  });

  it('recognizes a Claude Question as a question rather than a generic choice', () => {
    const screen = detectClaudeScreen(`Claude Code v2.1.235
☐ Choice
Which option should I use?
❯ 1. Alpha
  2. Beta
  3. Type something.
────────────────────────────────────────
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel`);
    expect(screen.state).toBe('input');
    expect(screen.interaction).toMatchObject({ kind: 'question', title: 'Which option should I use?' });
    expect(screen.actions.map(({ key }) => key)).toEqual(['1', '2', '3', '4']);
    expect(screen.actions[2]).toMatchObject({
      role: 'custom-input', editor: { submitKey: 'Enter', commitsInteraction: true },
    });
    expect(screen.actions[2]?.editor).not.toHaveProperty('openKey');
  });

  it('keeps running while Claude is still executing Stop hooks', () => {
    const screen = detectClaudeScreen(`Claude Code v2.1.235
❯
running stop hooks… 1/15`);
    expect(screen.state).toBe('running');
  });

  it('recognizes the initial trust choice', () => {
    const screen = detectClaudeScreen(`Claude Code v2.1.235
Do you trust the files in this folder?
❯ 1. Yes, I trust this folder
  2. No, exit
Enter to confirm · Esc to cancel`);
    expect(screen.state).toBe('input');
    expect(screen.actions.map(({ key }) => key)).toEqual(['1', '2']);
  });
});
