import type { AgentId, AgentResume } from '../agents/types.js';
import { AppError } from '../core/errors.js';
import { validateWorkspaceDirectory } from '../workspace/path.js';

export interface StartSessionRequest {
  sessionId: string;
  agent: AgentId;
  cwd: string;
  resume?: AgentResume;
}

export async function validateStartSessionRequest(request: StartSessionRequest): Promise<StartSessionRequest> {
  if (!validSessionId(request.sessionId)) {
    throw new AppError(
      'INVALID_SESSION_NAME',
      'session name must use letters, digits, underscore, or dash',
      { sessionId: request.sessionId },
    );
  }
  const cwd = await validateWorkspaceDirectory(request.cwd);
  if (request.resume?.mode === 'session' && !request.resume.sessionId.trim()) {
    throw new AppError('INVALID_RESUME', 'resume session id must not be empty', {
      reason: '恢复历史会话时必须提供 session ID',
    });
  }
  return { ...request, cwd };
}

export function validSessionId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,40}$/.test(value);
}
