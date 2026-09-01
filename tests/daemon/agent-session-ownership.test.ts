import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantDaemon } from '../../src/daemon/server.js';
import type { ManagedSession, SessionState } from '../../src/core/model.js';
import type { DaemonResult } from '../../src/daemon/protocol.js';
import { resolveNativeAgentSessionId } from '../../src/session/native-session.js';

vi.mock('../../src/session/native-session.js', () => ({
  resolveNativeAgentSessionId: vi.fn(),
}));

describe('native agent session ownership', () => {
  beforeEach(() => vi.mocked(resolveNativeAgentSessionId).mockReset());

  it('keeps the first LCA owner and stops a duplicate native session', async () => {
    const owner = session('owner', '%1');
    const duplicate = session('duplicate', '%2');
    const daemon = Object.create(AssistantDaemon.prototype) as AssistantDaemon;
    const internal = daemon as unknown as InternalDaemon;
    internal.state = state(owner, duplicate);
    internal.pendingAgentSessionClaims = new Map();
    internal.pendingResumePickers = new Map();
    internal.pendingStartupConflicts = new Map();
    internal.store = { saveState: async () => undefined };
    const killed: string[] = [];
    internal.tmux = {
      hasSession: async () => true,
      inspect: async (paneId) => ({ paneId, pid: paneId === '%1' ? 1 : 2, dead: false }),
      killSession: async (name) => { killed.push(name); },
      writeMetadata: async () => undefined,
    };
    const messages: string[] = [];
    internal.gateway = { sendText: async (_chatId, text) => { messages.push(text); } };
    internal.log = async () => undefined;
    vi.mocked(resolveNativeAgentSessionId).mockResolvedValue('native-thread');

    expect(await internal.handleAgentSessionStarted(candidate('owner'))).toEqual({ ok: true });
    const conflict = await internal.handleAgentSessionStarted(candidate('duplicate'));
    expect(conflict).toMatchObject({ ok: false, errorCode: 'AGENT_SESSION_IN_USE' });

    expect(killed).toEqual(['lca-duplicate']);
    expect(internal.state.sessions?.owner?.agentSessionId).toBe('native-thread');
    expect(internal.state.sessions?.duplicate).toBeUndefined();
    expect(internal.state.recentSessionExits?.duplicate).toMatchObject({
      reason: 'agent-session-conflict', agentSessionId: 'native-thread', ownerSessionId: 'owner',
    });
    expect(messages.at(-1)).toContain('已由 LCA session「owner」连接');
  });

  it('does not reject a session when its hook candidate disagrees with its pane PID', async () => {
    const owner = session('owner', '%1');
    owner.agentSessionId = 'old-native-thread';
    const duplicate = session('duplicate', '%2');
    const daemon = Object.create(AssistantDaemon.prototype) as AssistantDaemon;
    const internal = daemon as unknown as InternalDaemon;
    internal.state = state(owner, duplicate);
    internal.pendingAgentSessionClaims = new Map();
    internal.pendingResumePickers = new Map();
    internal.pendingStartupConflicts = new Map();
    internal.store = { saveState: async () => undefined };
    const killed: string[] = [];
    internal.tmux = {
      hasSession: async () => true,
      inspect: async (paneId) => ({ paneId, pid: paneId === '%1' ? 1 : 2, dead: false }),
      killSession: async (name) => { killed.push(name); },
      writeMetadata: async () => undefined,
    };
    internal.gateway = { sendText: async () => undefined };
    internal.log = async () => undefined;
    vi.mocked(resolveNativeAgentSessionId).mockResolvedValue('new-native-thread');

    expect(await internal.handleAgentSessionStarted(candidate('duplicate'))).toEqual({ ok: true });

    expect(killed).toEqual([]);
    expect(internal.state.sessions?.duplicate?.agentSessionId).toBe('new-native-thread');
  });
});

function session(id: string, paneId: string): ManagedSession {
  return { id, agent: 'traex', sessionName: `lca-${id}`, paneId, cwd: '/work', agentVersion: 'test', updatedAt: 1 };
}

function state(...sessions: ManagedSession[]): SessionState {
  return {
    schemaVersion: 2,
    boundChatId: 'oc_1',
    activeSessionId: sessions[0]?.id,
    sessions: Object.fromEntries(sessions.map((value) => [value.id, value])),
    updatedAt: 1,
  };
}

function candidate(sessionId: string) {
  return { sessionId, agent: 'traex' as const, agentSessionId: 'native-thread', cwd: '/work', source: 'resume' };
}

interface InternalDaemon {
  state: SessionState;
  pendingAgentSessionClaims: Map<string, ReturnType<typeof candidate>>;
  pendingResumePickers: Map<string, unknown>;
  pendingStartupConflicts: Map<string, unknown>;
  store: { saveState(state: SessionState): Promise<void> };
  tmux: {
    hasSession(name: string): Promise<boolean>;
    inspect(paneId: string): Promise<{ paneId: string; pid: number; dead: boolean }>;
    killSession(name: string): Promise<void>;
    writeMetadata(name: string, metadata: unknown): Promise<void>;
  };
  gateway: { sendText(chatId: string, text: string): Promise<void> };
  log(message: string): Promise<void>;
  handleAgentSessionStarted(value: ReturnType<typeof candidate>): Promise<DaemonResult>;
}
