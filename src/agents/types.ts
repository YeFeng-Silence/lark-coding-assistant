import type { AppConfig } from '../core/model.js';
import type { ScreenDetection } from '../screen/detector.js';

export const AGENT_IDS = ['codex', 'traex', 'claude'] as const;
export type AgentId = typeof AGENT_IDS[number];
export type LegacyAgentId = 'trae-cli' | 'claude-code';

export function normalizeAgentId(value: string): AgentId | undefined {
  if (value === 'trae-cli') return 'traex';
  if (value === 'claude-code') return 'claude';
  return (AGENT_IDS as readonly string[]).includes(value) ? value as AgentId : undefined;
}

export type AgentResume =
  | { mode: 'picker'; all?: boolean }
  | { mode: 'last' }
  | { mode: 'session'; sessionId: string };

export interface ResumeOptions {
  resume?: boolean | string;
  resumeLast?: boolean;
  resumeAll?: boolean;
}

export interface TurnCompleteCandidate {
  sessionId: string;
  eventId: string;
  agentSessionId: string;
  cwd: string;
  lastAssistantMessage: string;
}

export interface AgentSessionStartedCandidate {
  sessionId: string;
  agent: AgentId;
  agentSessionId: string;
  cwd: string;
  source?: string;
}

export interface LaunchInput {
  resume?: AgentResume;
  stopHookCommand: string;
}

export interface AgentAdapter {
  id: AgentId;
  displayName: string;
  groupOrder: number;
  binary(config: AppConfig): string;
  versionArgs: readonly string[];
  buildLaunchArgs(input: LaunchInput): string[];
  detectScreen(raw: string, paneAlive: boolean, cursor?: { x: number; y: number }): ScreenDetection;
}
