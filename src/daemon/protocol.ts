import type { ScreenDetection } from '../screen/detector.js';
import type { ManagedSession, SessionState } from '../core/model.js';
import type { AgentId, AgentResume, TurnCompleteCandidate } from '../agents/types.js';
import type { AppErrorCode, ErrorContext } from '../core/errors.js';

export type DaemonRequest =
  | { id: string; method: 'ping' }
  | { id: string; method: 'shutdown' }
  | { id: string; method: 'start'; cwd: string; sessionId: string; agent: AgentId; resume?: AgentResume }
  | { id: string; method: 'status'; sessionId?: string }
  | { id: string; method: 'tail'; lines?: number }
  | { id: string; method: 'send'; text: string }
  | { id: string; method: 'key'; key: string; fingerprint: string }
  | { id: string; method: 'stop'; sessionId?: string }
  | { id: string; method: 'useSession'; sessionId: string }
  | { id: string; method: 'bindCode' }
  | { id: string; method: 'resetOwner' }
  | { id: string; method: 'turnComplete'; candidate: TurnCompleteCandidate };

export type DaemonRequestInput = DaemonRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, 'id'>
    : never
  : never;

export type DaemonResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: string; errorCode?: AppErrorCode; errorContext?: ErrorContext };

export interface DaemonInfo {
  version: string;
  pid: number;
}

export interface RuntimeStatus {
  state: SessionState;
  session?: ManagedSession;
  screen?: ScreenDetection;
  paneAlive: boolean;
}
