import type { AgentId } from '../agents/types.js';
import type { DaemonResult } from '../daemon/protocol.js';

export interface SessionStartupFailure {
  sessionId: string;
  agent: AgentId;
  cwd?: string;
  reason?: 'exited' | 'timeout';
  stage?: string;
  elapsedMs?: number;
  exitStatus?: number;
  terminalExcerpt: string;
}

export function sessionStartupFailure(
  result: DaemonResult,
  fallback: Pick<SessionStartupFailure, 'sessionId' | 'agent'>,
): SessionStartupFailure | undefined {
  if (result.ok || (result.errorCode !== 'AGENT_EXITED_DURING_STARTUP'
    && result.errorCode !== 'SESSION_START_TIMEOUT')) return undefined;
  const context = result.errorContext ?? {};
  return {
    sessionId: typeof context.sessionId === 'string' ? context.sessionId : fallback.sessionId,
    agent: fallback.agent,
    reason: result.errorCode === 'SESSION_START_TIMEOUT' ? 'timeout' : 'exited',
    ...(typeof context.cwd === 'string' ? { cwd: context.cwd } : {}),
    ...(typeof context.stage === 'string' ? { stage: context.stage } : {}),
    ...(typeof context.elapsedMs === 'number' ? { elapsedMs: context.elapsedMs } : {}),
    ...(typeof context.exitStatus === 'number' ? { exitStatus: context.exitStatus } : {}),
    terminalExcerpt: typeof context.terminalExcerpt === 'string' && context.terminalExcerpt.trim()
      ? context.terminalExcerpt
      : 'Agent 未输出可用错误信息。',
  };
}
