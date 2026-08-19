import { codexAdapter } from './codex.js';
import { traeCliAdapter } from './trae-cli.js';
import { claudeCodeAdapter } from './claude-code.js';
import { AGENT_IDS, type AgentAdapter, type AgentId } from './types.js';

const adapters = new Map<AgentId, AgentAdapter>([
  [codexAdapter.id, codexAdapter],
  [traeCliAdapter.id, traeCliAdapter],
  [claudeCodeAdapter.id, claudeCodeAdapter],
]);

export function getAgentAdapter(id: AgentId): AgentAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`unsupported coding agent: ${id}`);
  return adapter;
}

export function listAgentAdapters(): AgentAdapter[] {
  return [...adapters.values()].sort((left, right) => left.groupOrder - right.groupOrder);
}

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}
