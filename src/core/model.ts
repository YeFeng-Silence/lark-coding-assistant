import type { AgentId } from '../agents/types.js';

export type Tenant = 'feishu' | 'lark';

export interface AppConfig {
  tenant: Tenant;
  appId: string;
  tmuxBinary: string;
  agentBinaries: Record<AgentId, string>;
  pollIntervalMs: number;
  workspaceRoots: string[];
}

export interface RecentWorkspace {
  cwd: string;
  lastUsedAt: number;
}

export interface AppSecrets {
  appSecret: string;
  callbackSecret: string;
}

export interface ManagedSession {
  id: string;
  agent: AgentId;
  sessionName: string;
  paneId: string;
  cwd: string;
  agentVersion: string;
  agentSessionId?: string;
  updatedAt: number;
}

export interface SessionExitEvent {
  sessionId: string;
  agent: AgentId;
  reason: 'agent-session-conflict';
  agentSessionId: string;
  ownerSessionId: string;
  occurredAt: number;
}

export interface SessionState {
  schemaVersion: 2;
  ownerOpenId?: string;
  boundChatId?: string;
  autoBindDisabled?: boolean;
  activeSessionId?: string;
  sessions?: Record<string, ManagedSession>;
  recentSessionExits?: Record<string, SessionExitEvent>;
  recentWorkspaces?: RecentWorkspace[];
  bindCodeHash?: string;
  bindCodeExpiresAt?: number;
  updatedAt: number;
}

export function emptyState(now = Date.now()): SessionState {
  return { schemaVersion: 2, sessions: {}, updatedAt: now };
}
