import type { AgentId } from '../agents/types.js';
import type { DaemonResult } from '../daemon/protocol.js';

export interface SessionStartupFailure {
  sessionId: string;
  agent: AgentId;
  exitStatus?: number;
  terminalExcerpt: string;
}

export function sessionStartupFailure(
  result: DaemonResult,
  fallback: Pick<SessionStartupFailure, 'sessionId' | 'agent'>,
): SessionStartupFailure | undefined {
  if (result.ok || result.errorCode !== 'AGENT_EXITED_DURING_STARTUP') return undefined;
  const context = result.errorContext ?? {};
  return {
    sessionId: typeof context.sessionId === 'string' ? context.sessionId : fallback.sessionId,
    agent: fallback.agent,
    ...(typeof context.exitStatus === 'number' ? { exitStatus: context.exitStatus } : {}),
    terminalExcerpt: typeof context.terminalExcerpt === 'string' && context.terminalExcerpt.trim()
      ? context.terminalExcerpt
      : 'Agent 未输出可用错误信息。',
  };
}
