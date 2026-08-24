import { describe, expect, it } from 'vitest';
import type { CardActionEvent } from '@larksuite/channel';
import { AssistantDaemon } from '../../src/daemon/server.js';
import { detectClaudeScreen, detectCodexScreen, detectTraeScreen } from '../../src/screen/detector.js';
import type { SignedAction } from '../../src/lark/action-signing.js';
import type { ScreenDetection } from '../../src/screen/detector.js';
import type { ManagedSession, SessionState } from '../../src/core/model.js';
import type { LarkActionResult } from '../../src/lark/gateway.js';
import { CHOICE_FORM_SUBMIT_ACTION } from '../../src/lark/cards.js';

describe('transactional toggle forms', () => {
  it('applies the complete form and submits the terminal interaction once', async () => {
    const screen = detectClaudeScreen(`────────────────────────────────────────
←  ☒ 回归  ✔ Submit  →
请选择能力
  1. [ ] Read
  Read files only.
  2. [ ] Edit
  Modify files.
❯ 3. [✔] done
     Submit
Enter to select · ↑/↓ to navigate · Esc to cancel`);
    const session = {
      id: 'claude-test', agent: 'claude' as const, sessionName: 'lca-claude-test',
      paneId: '%1', cwd: '/tmp', agentVersion: 'test', updatedAt: 1,
    };
    const daemon = Object.create(AssistantDaemon.prototype) as AssistantDaemon;
    const internal = daemon as unknown as {
      state: SessionState;
      screen: ScreenDetection;
      poll(): Promise<void>;
      flushPending(): Promise<void>;
      tmux: {
        sendKey(paneId: string, key: string): Promise<void>;
        sendText(paneId: string, text: string, submit: boolean): Promise<void>;
      };
      handleChoiceAction(action: SignedAction, session: ManagedSession, event: CardActionEvent): Promise<LarkActionResult>;
    };
    internal.state = { schemaVersion: 2, activeSessionId: session.id, sessions: { [session.id]: session }, updatedAt: 1 };
    internal.screen = screen;
    internal.poll = async () => undefined;
    internal.flushPending = async () => undefined;
    const keys: string[] = [];
    internal.tmux = {
      sendKey: async (_paneId: string, key: string) => {
        keys.push(key);
        if (key === 'Down' || key === 'Up') {
          const focusedIndex = internal.screen.actions.findIndex(({ focused }) => focused);
          const nextIndex = key === 'Down' ? focusedIndex + 1 : focusedIndex - 1;
          internal.screen = {
            ...internal.screen,
            actions: internal.screen.actions.map((item, index) => ({ ...item, focused: index === nextIndex })),
          };
        } else if (key === 'Enter') {
          const focused = internal.screen.actions.find(({ focused: isFocused }) => isFocused);
          if (focused?.role === 'submit') {
            internal.screen = {
              state: 'idle', confidence: 0.9, normalized: '', fingerprint: 'done', evidence: [], actions: [], hasDraftInput: false,
            };
          } else if (focused) {
            internal.screen = {
              ...internal.screen,
              actions: internal.screen.actions.map((item) => item.id === focused.id
                ? { ...item, marker: item.marker === 'checked' ? 'unchecked' as const : 'checked' as const }
                : item),
            };
          }
        }
      },
      sendText: async (_paneId: string, text: string) => {
        internal.screen = {
          ...internal.screen,
          actions: internal.screen.actions.map((item) => item.role === 'custom-input' ? { ...item, inputValue: text } : item),
        };
      },
    };

    const action: SignedAction = {
      v: 1, kind: 'choice', interactionKind: 'question', agent: 'claude', action: CHOICE_FORM_SUBMIT_ACTION,
      paneId: '%1', fingerprint: screen.interaction?.revision ?? screen.fingerprint,
      chatId: 'oc_1', nonce: 'test', expiresAt: Date.now() + 60_000, sig: 'test',
    };
    const event = {
      messageId: 'om_1', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: {
        value: undefined, tag: 'button', name: 'choice_form_submit',
        formValue: {
          choice_selected_0: true,
          choice_selected_1: false,
          choice_selected_2: true,
          custom_input_2: 'updated value',
        },
      },
    } as CardActionEvent;

    const result = await internal.handleChoiceAction(action, session, event);

    expect(result).toMatchObject({ type: 'success', content: '已向 claude 提交答案。' });
    expect(internal.screen.state).toBe('idle');
    expect(keys.filter((key) => key === 'Enter')).toHaveLength(2);
  });

  it('uses detected Trae toggle and editor keys while keeping the same form protocol', async () => {
    const screen = detectTraeScreen(`Question 1/1 (1 unanswered)
请选择测试项
❯ [ ] 1. 代码检查  进行代码静态检查
  [ ] 2. 执行测试  运行单元测试
  [ ] 3. Other     Optionally, add details in notes (tab).
space to toggle | tab to add notes | enter to submit answer
esc to interrupt`);
    const session = {
      id: 'helix', agent: 'traex' as const, sessionName: 'lca-helix', paneId: '%2',
      cwd: '/tmp', agentVersion: 'test', updatedAt: 1,
    };
    const daemon = Object.create(AssistantDaemon.prototype) as AssistantDaemon;
    const internal = daemon as unknown as {
      state: SessionState;
      screen: ScreenDetection;
      poll(): Promise<void>;
      flushPending(): Promise<void>;
      tmux: {
        sendKey(paneId: string, key: string): Promise<void>;
        sendText(paneId: string, text: string, submit: boolean): Promise<void>;
      };
      handleChoiceAction(action: SignedAction, session: ManagedSession, event: CardActionEvent): Promise<LarkActionResult>;
    };
    internal.state = { schemaVersion: 2, activeSessionId: session.id, sessions: { [session.id]: session }, updatedAt: 1 };
    internal.screen = screen;
    internal.poll = async () => undefined;
    internal.flushPending = async () => undefined;
    const keys: string[] = [];
    let editorOpen = false;
    let typed = '';
    internal.tmux = {
      sendKey: async (_paneId: string, key: string) => {
        keys.push(key);
        if (key === 'Down' || key === 'Up') {
          const focusedIndex = internal.screen.actions.findIndex(({ focused }) => focused);
          const nextIndex = key === 'Down' ? focusedIndex + 1 : focusedIndex - 1;
          internal.screen = {
            ...internal.screen,
            actions: internal.screen.actions.map((item, index) => ({ ...item, focused: index === nextIndex })),
          };
        } else if (key === 'Space') {
          const focused = internal.screen.actions.find(({ focused: isFocused }) => isFocused);
          internal.screen = {
            ...internal.screen,
            actions: internal.screen.actions.map((item) => item.id === focused?.id
              ? { ...item, marker: item.marker === 'checked' ? 'unchecked' as const : 'checked' as const }
              : item),
          };
        } else if (key === 'Tab') {
          editorOpen = true;
        } else if (key === 'Enter' && editorOpen) {
          internal.screen = {
            state: 'idle', confidence: 0.9, normalized: '', fingerprint: 'done', evidence: [], actions: [], hasDraftInput: false,
          };
        }
      },
      sendText: async (_paneId: string, text: string) => {
        typed = text;
      },
    };
    const action: SignedAction = {
      v: 1, kind: 'choice', interactionKind: 'question', agent: 'traex', action: CHOICE_FORM_SUBMIT_ACTION,
      paneId: '%2', fingerprint: screen.interaction?.revision ?? screen.fingerprint,
      chatId: 'oc_1', nonce: 'test', expiresAt: Date.now() + 60_000, sig: 'test',
    };
    const result = await internal.handleChoiceAction(action, session, {
      messageId: 'om_2', chatId: 'oc_1', operator: { openId: 'ou_1' },
      action: {
        value: undefined, tag: 'button', name: 'choice_form_submit',
        formValue: {
          choice_selected_0: true,
          choice_selected_1: false,
          choice_selected_2: true,
          custom_input_2: 'Trae 自定义回归',
        },
      },
    } as CardActionEvent);

    expect(result).toMatchObject({ type: 'success', content: '已向 traex 提交答案。' });
    expect(keys.filter((key) => key === 'Space')).toHaveLength(2);
    expect(keys.filter((key) => key === 'Enter')).toHaveLength(1);
    expect(keys).toContain('Tab');
    expect(typed).toBe('Trae 自定义回归');
    expect(internal.screen.state).toBe('idle');
  });
});

describe('single-choice custom input', () => {
  it('opens the detected Codex notes editor without prematurely submitting the choice', async () => {
    const screen = detectCodexScreen(`Question 1/1 (1 unanswered)
请选择验证环境
› 1. 测试环境 (Recommended)  用于回归验证。
  2. 生产环境                用于正式发布。
  3. None of the above       Optionally, add details in notes (tab).
tab to add notes | enter to submit answer | esc to interrupt`);
    const session = {
      id: 'codex-probe', agent: 'codex' as const, sessionName: 'lca-codex-probe', paneId: '%3',
      cwd: '/tmp', agentVersion: '0.148.0', updatedAt: 1,
    };
    const daemon = Object.create(AssistantDaemon.prototype) as AssistantDaemon;
    const internal = daemon as unknown as {
      state: SessionState;
      screen: ScreenDetection;
      pendingInteractionInput?: { submitOnInput: boolean; interactionId: string };
      poll(): Promise<void>;
      tmux: { sendKey(paneId: string, key: string): Promise<void> };
      handleChoiceAction(action: SignedAction, session: ManagedSession, event: CardActionEvent): Promise<LarkActionResult>;
    };
    internal.state = { schemaVersion: 2, activeSessionId: session.id, sessions: { [session.id]: session }, updatedAt: 1 };
    internal.screen = screen;
    internal.poll = async () => undefined;
    const keys: string[] = [];
    internal.tmux = {
      sendKey: async (_paneId: string, key: string) => {
        keys.push(key);
        if (key === 'Down') {
          const focused = internal.screen.actions.findIndex((item) => item.focused);
          internal.screen = {
            ...internal.screen,
            actions: internal.screen.actions.map((item, index) => ({ ...item, focused: index === focused + 1 })),
          };
        }
      },
    };
    const action: SignedAction = {
      v: 1, kind: 'choice', interactionKind: 'question', agent: 'codex', action: '3', paneId: '%3',
      fingerprint: screen.interaction?.revision ?? screen.fingerprint, chatId: 'oc_1', nonce: 'test',
      expiresAt: Date.now() + 60_000, sig: 'test',
    };

    const result = await internal.handleChoiceAction(action, session, {
      messageId: 'om_codex', chatId: 'oc_1', operator: { openId: 'ou_1' }, action: { value: action, tag: 'button' },
    } as CardActionEvent);

    expect(result).toMatchObject({ type: 'awaiting-input', label: 'None of the above' });
    expect(keys).toEqual(['Down', 'Down', 'Tab']);
    expect(keys).not.toContain('Enter');
    expect(internal.pendingInteractionInput).toMatchObject({ submitOnInput: true });
  });

  it('focuses Claude Type something and waits for direct typing without pressing Enter first', async () => {
    const screen = detectClaudeScreen(`────────────────────────────────────────────────────────────────
 ☐ Claude 单选回归

请选择 Claude 回归环境

❯ 1. 测试环境
     用于回归验证
  2. 生产环境
     用于正式发布
  3. Type something.
────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel`);
    const session = {
      id: 'claude-test', agent: 'claude' as const, sessionName: 'lca-claude-test', paneId: '%4',
      cwd: '/tmp', agentVersion: '2.1.235', updatedAt: 1,
    };
    const daemon = Object.create(AssistantDaemon.prototype) as AssistantDaemon;
    const internal = daemon as unknown as {
      state: SessionState;
      screen: ScreenDetection;
      pendingInteractionInput?: { submitOnInput: boolean };
      poll(): Promise<void>;
      tmux: { sendKey(paneId: string, key: string): Promise<void> };
      handleChoiceAction(action: SignedAction, session: ManagedSession, event: CardActionEvent): Promise<LarkActionResult>;
    };
    internal.state = { schemaVersion: 2, activeSessionId: session.id, sessions: { [session.id]: session }, updatedAt: 1 };
    internal.screen = screen;
    internal.poll = async () => undefined;
    const keys: string[] = [];
    internal.tmux = {
      sendKey: async (_paneId: string, key: string) => {
        keys.push(key);
        if (key === 'Down') {
          const focused = internal.screen.actions.findIndex((item) => item.focused);
          internal.screen = {
            ...internal.screen,
            actions: internal.screen.actions.map((item, index) => ({ ...item, focused: index === focused + 1 })),
          };
        }
      },
    };
    const action: SignedAction = {
      v: 1, kind: 'choice', interactionKind: 'question', agent: 'claude', action: '3', paneId: '%4',
      fingerprint: screen.interaction?.revision ?? screen.fingerprint, chatId: 'oc_1', nonce: 'test',
      expiresAt: Date.now() + 60_000, sig: 'test',
    };

    const result = await internal.handleChoiceAction(action, session, {
      messageId: 'om_claude', chatId: 'oc_1', operator: { openId: 'ou_1' }, action: { value: action, tag: 'button' },
    } as CardActionEvent);

    expect(result).toMatchObject({ type: 'awaiting-input', label: 'Type something' });
    expect(keys).toEqual(['Down', 'Down']);
    expect(keys).not.toContain('Enter');
    expect(internal.pendingInteractionInput).toMatchObject({ submitOnInput: true });
  });
});
