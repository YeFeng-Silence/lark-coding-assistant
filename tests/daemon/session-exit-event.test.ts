import { describe, expect, it } from 'vitest';
import { AssistantDaemon } from '../../src/daemon/server.js';
import type { ManagedSession, SessionState } from '../../src/core/model.js';

describe('session exit events', () => {
  it('persists a non-zero pane exit with a sanitized terminal excerpt', async () => {
    const session = managedSession('resume-target');
    const daemon = Object.create(AssistantDaemon.prototype) as AssistantDaemon;
    const internal = daemon as unknown as InternalDaemon;
    internal.state = state(session);
    internal.reconciler = {
      reconcile: async () => ({
        state: { ...state(), updatedAt: 2 },
        liveSessions: [],
        removedSessions: [{
          session,
          pane: { exitStatus: 1 },
          terminalOutput: 'Codex\nError: session already has an active writer\n',
        }],
        removedActive: session,
        changed: true,
      }),
    };
    internal.store = { saveState: async () => undefined };
    internal.pendingResumePickers = new Map();
    internal.pendingStartupConflicts = new Map();
    internal.completedEvents = new Set();
    internal.pendingMessages = [];
    internal.unresolvedNotified = new Set();
    internal.log = async () => undefined;

    await internal.reconcileSessions();

    expect(internal.state.sessions?.['resume-target']).toBeUndefined();
    expect(internal.state.recentSessionExits?.['resume-target']).toMatchObject({
      reason: 'agent-exited',
      agent: 'codex',
      exitStatus: 1,
      terminalExcerpt: 'Error: session already has an active writer',
    });
  });
});

function managedSession(id: string): ManagedSession {
  return {
    id,
    agent: 'codex',
    sessionName: `lark-coding-assistant-${id}`,
    paneId: '%1',
    cwd: '/work',
    agentVersion: 'test',
    updatedAt: 1,
  };
}

function state(session?: ManagedSession): SessionState {
  return {
    schemaVersion: 2,
    activeSessionId: session?.id,
    sessions: session ? { [session.id]: session } : {},
    updatedAt: 1,
  };
}

interface InternalDaemon {
  state: SessionState;
  reconciler: {
    reconcile(state: SessionState, discover?: boolean, signal?: AbortSignal): Promise<{
      state: SessionState;
      liveSessions: ManagedSession[];
      removedSessions: Array<{ session: ManagedSession; pane?: { exitStatus?: number }; terminalOutput?: string }>;
      removedActive?: ManagedSession;
      changed: boolean;
    }>;
  };
  store: { saveState(state: SessionState): Promise<void> };
  pendingResumePickers: Map<string, unknown>;
  pendingStartupConflicts: Map<string, { ownerSessionId: string }>;
  completedEvents: Set<string>;
  pendingMessages: string[];
  unresolvedNotified: Set<string>;
  log(message: string): Promise<void>;
  reconcileSessions(discover?: boolean, signal?: AbortSignal): Promise<ManagedSession[]>;
}
