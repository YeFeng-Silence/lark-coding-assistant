import type { AgentId, AgentSessionStartedCandidate, TurnCompleteCandidate } from './types.js';

export function normalizeSessionStartEvent(
  bridgeSessionId: string,
  agent: AgentId,
  value: unknown,
): AgentSessionStartedCandidate | undefined {
  if (!bridgeSessionId || !value || typeof value !== 'object') return undefined;
  const event = value as Record<string, unknown>;
  if (event.hook_event_name !== 'SessionStart') return undefined;
  const agentSessionId = stringField(event, 'session_id');
  const cwd = stringField(event, 'cwd');
  if (!agentSessionId || !cwd) return undefined;
  return { sessionId: bridgeSessionId, agent, agentSessionId, cwd, source: stringField(event, 'source') };
}

export function validSessionStartCandidate(value: unknown): value is AgentSessionStartedCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0
    && (candidate.agent === 'codex' || candidate.agent === 'traex' || candidate.agent === 'claude')
    && typeof candidate.agentSessionId === 'string' && candidate.agentSessionId.length > 0
    && typeof candidate.cwd === 'string' && candidate.cwd.length > 0;
}

export function normalizeStopEvent(
  bridgeSessionId: string,
  value: unknown,
): TurnCompleteCandidate | undefined {
  if (!bridgeSessionId || !value || typeof value !== 'object') return undefined;
  const event = value as Record<string, unknown>;
  if (event.hook_event_name !== 'Stop') return undefined;
  const eventId = stringField(event, 'turn_id') ?? stringField(event, 'prompt_id');
  const agentSessionId = stringField(event, 'session_id');
  const cwd = stringField(event, 'cwd');
  const lastAssistantMessage = stringField(event, 'last_assistant_message')?.trim();
  if (!eventId || !agentSessionId || !cwd || !lastAssistantMessage) return undefined;
  return { sessionId: bridgeSessionId, eventId, agentSessionId, cwd, lastAssistantMessage };
}

export function validTurnCompleteCandidate(value: unknown): value is TurnCompleteCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ['sessionId', 'eventId', 'agentSessionId', 'cwd', 'lastAssistantMessage']
    .every((key) => typeof candidate[key] === 'string' && (candidate[key] as string).length > 0);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}
