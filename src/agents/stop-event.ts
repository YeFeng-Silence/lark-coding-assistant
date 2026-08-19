import type { TurnCompleteCandidate } from './types.js';

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
