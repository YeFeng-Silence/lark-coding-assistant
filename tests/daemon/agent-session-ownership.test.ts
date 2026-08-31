import { describe, expect, it } from 'vitest';
import { AssistantDaemon } from '../../src/daemon/server.js';
import type { ManagedSession, SessionState } from '../../src/core/model.js';
import type { DaemonResult } from '../../src/daemon/protocol.js';

describe('native agent session ownership', () => {
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
      killSession: async (name) => { killed.push(name); },
      writeMetadata: async () => undefined,
    };
    const messages: string[] = [];
    internal.gateway = { sendText: async (_chatId, text) => { messages.push(text); } };
    internal.log = async () => undefined;

    expect(await internal.handleAgentSessionStarted(candidate('owner'))).toEqual({ ok: true });
    const conflict = await internal.handleAgentSessionStarted(candidate('duplicate'));
    expect(conflict).toMatchObject({ ok: false, errorCode: 'AGENT_SESSION_IN_USE' });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(killed).toEqual(['lca-duplicate']);
    expect(internal.state.sessions?.owner?.agentSessionId).toBe('native-thread');
    expect(internal.state.sessions?.duplicate).toBeUndefined();
    expect(internal.state.recentSessionExits?.duplicate).toMatchObject({
      reason: 'agent-session-conflict', agentSessionId: 'native-thread', ownerSessionId: 'owner',
    });
    expect(messages.at(-1)).toContain('已由 LCA session「owner」连接');
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
    killSession(name: string): Promise<void>;
    writeMetadata(name: string, metadata: unknown): Promise<void>;
  };
  gateway: { sendText(chatId: string, text: string): Promise<void> };
  log(message: string): Promise<void>;
  handleAgentSessionStarted(value: ReturnType<typeof candidate>): Promise<DaemonResult>;
}
